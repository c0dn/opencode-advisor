import { Plugin } from "@opencode/plugin"

import { advisorCommand, commandArgs, goalCommand } from "./src/commands.ts"
import { loadGoal, resumeRunningGoals, waitForDependencies, type JobInput } from "./src/goal.ts"
import type { Host } from "./src/host.ts"
import { installConsultations } from "./src/consultation.ts"
import { Advisor } from "./src/rpc.ts"

/**
 * The server half: native advisor context, the goal loop, and the RPC the TUI's
 * /advisor and /goal commands call.
 */
export default Plugin.define({
  id: "opencode-advisor",
  async setup(context) {
    const lifecycle = new AbortController()
    const host: Host = {
      signal: lifecycle.signal,
      context: (sessionID) => context.session.context({ sessionID }),
      async generate(prompt, model) {
        return (await context.generate.text({ prompt, model: model ?? null })).text
      },
      async turn(sessionID, text) {
        // The TUI shows only the description, so make it say which round this is.
        const description = text.match(/^\[(goal round \d+\/(?:\d+|∞))\]/)?.[1] ?? "goal"
        await context.session.synthetic({ sessionID, text, description, delivery: "queue", resume: true })
      },
      async notify(sessionID, text) {
        await rpc.events.emit("notice", { sessionID, text })
      },
      wait: (sessionID) => context.session.wait({ sessionID }),
      storage: {
        get: (key) => context.storage.get(key),
        set: (key, value) => context.storage.set(key, value as Parameters<typeof context.storage.set>[1]),
        remove: (key) => context.storage.remove(key),
        async scan(prefix) {
          const entries: { key: string; value: unknown }[] = []
          let after: string | undefined
          do {
            const page = await context.storage.scan({ prefix, after })
            entries.push(...page.entries)
            after = page.next
          } while (after)
          return entries
        },
      },
      project: context.location.project.directory,
      options: context.options,
    }

    // `goal: false` leaves /goal to another plugin.
    const goalEnabled = context.options.goal !== false
    const failure = (error: unknown) => (error instanceof Error ? error.message : String(error))
    const rpc = await context.rpc.register(Advisor, {
      async features() {
        return { goal: goalEnabled }
      },
      async advisor(input) {
        const { args } = input as { args: string }
        return { text: await advisorCommand(host, commandArgs("advisor", args)).catch(failure) }
      },
      async goalStatus(input) {
        return { goal: (await loadGoal(host, (input as { sessionID: string }).sessionID)) ?? null }
      },
      async goal(input) {
        const { sessionID, args } = input as { sessionID: string; args: string }
        if (!goalEnabled) return { text: "/goal is turned off in this plugin's options." }
        return { text: await goalCommand(host, sessionID, commandArgs("goal", args)).catch(failure) }
      },
    })

    const disposeConsultations = await installConsultations(context, host)

    const tools = await context.tool.transform((draft) => {
      if (!goalEnabled) return
      draft.add({
        name: "goal_wait",
        description: "Suspend /goal judging while waiting for background work, then end your turn. ids: native background shell IDs or child sessionIDs from this session (short waits; native completion wakes you; lost if OpenCode restarts or drops the shell). jobs: detached work launched with the plugin's oc-job script, systemd-run or setsid (training, long evals); the plugin checks the log's EXIT= marker, unit or pid from host state, survives OpenCode restarts, and queues the result turn itself. A lost or expired dependency gets one reconcile turn. Do not poll or duplicate the work. Not for persistent dev servers.",
        input: {
          type: "object",
          properties: {
            ids: { type: "array", items: { type: "string" }, maxItems: 20, description: "Shell IDs or child sessionIDs returned by this session's native background tools. Wait for all of them." },
            jobs: {
              type: "array",
              maxItems: 20,
              description: "Detached jobs. Each finishes when its log's last marker line (default EXIT=<code>) appears, or is reported as ended when its unit/pid stops without one.",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "Short unique label, e.g. run3." },
                  log: { type: "string", description: "Absolute path of the job's own log; the wrapper appends EXIT=<rc>." },
                  unit: { type: "string", description: "systemd --user unit, e.g. oc-run3.service." },
                  pid: { type: "integer", minimum: 1, description: "Process ID, for setsid/nohup jobs." },
                  marker: { type: "string", description: "Exit marker prefix; default EXIT=." },
                },
                required: ["name", "log"],
                additionalProperties: false,
              },
            },
            reason: { type: "string", minLength: 1 },
            timeoutSeconds: { type: "integer", minimum: 1, maximum: 2592000, description: "Wait deadline; default 86400 (24h). Max 7 days with native ids, 30 days for job-only waits. Expiry queues one reconcile turn, never restarts work." },
          },
          required: ["reason"],
          additionalProperties: false,
        },
        options: { codemode: false as const },
        async execute(input, toolContext) {
          const args = input as { ids?: string[]; jobs?: JobInput[]; reason: string; timeoutSeconds?: number }
          await waitForDependencies(host, toolContext.sessionID, args.ids ?? [], args.reason, args.timeoutSeconds, args.jobs ?? [])
          return { content: "Goal waiting. End your turn now. Native completions or the plugin's job check will wake you. Do not poll or duplicate the background work. /goal resume overrides this wait; /goal stop stops the goal, not the jobs." }
        },
      })
    })

    if (goalEnabled) void resumeRunningGoals(host)

    return async () => {
      lifecycle.abort()
      await disposeConsultations()
      await tools.dispose()
      await rpc.dispose()
    }
  },
})
