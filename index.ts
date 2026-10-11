import { Plugin } from "@opencode/plugin"

import { advisorCommand, commandArgs, goalCommand } from "./src/commands.ts"
import { resumeRunningGoals } from "./src/goal.ts"
import type { Host } from "./src/host.ts"
import { askOracle } from "./src/oracle.ts"
import { Advisor } from "./src/rpc.ts"

const ORACLE_DESCRIPTION =
  "Consult the oracle: a stronger, independent advisor model that reads this whole session's transcript and answers one question. Use it for a second opinion before committing to a non-trivial plan, after two failed attempts at the same bug, before risky or irreversible changes, or when unsure the work is really done. It cannot run tools; put what it should focus on in the question."

const ORACLE_INPUT = {
  type: "object",
  properties: {
    question: { type: "string", minLength: 1, description: "What you want advice on, with the specific decision, doubt, or failure." },
    model: {
      type: "string",
      description: "Override the configured advisor model for this call, as provider/model[#variant]. Usually omit.",
    },
  },
  required: ["question"],
  additionalProperties: false,
} as const

/**
 * The server half: the oracle_ask tool, the goal loop, and the RPC the TUI's
 * /advisor and /goal commands call.
 */
export default Plugin.define({
  id: "opencode-advisor",
  async setup(context) {
    const host: Host = {
      context: (sessionID) => context.session.context({ sessionID }),
      async generate(prompt, model) {
        return (await context.generate.text({ prompt, model: model ?? null })).text
      },
      async turn(sessionID, text) {
        // The TUI shows only the description, so make it say which round this is.
        const description = text.match(/^\[(goal round \d+\/\d+)\]/)?.[1] ?? "goal"
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
      async goal(input) {
        const { sessionID, args } = input as { sessionID: string; args: string }
        if (!goalEnabled) return { text: "/goal is turned off in this plugin's options." }
        return { text: await goalCommand(host, sessionID, commandArgs("goal", args)).catch(failure) }
      },
    })

    const tools = await context.tool.transform((draft) => {
      draft.add({
        name: "oracle_ask",
        description: ORACLE_DESCRIPTION,
        input: ORACLE_INPUT,
        options: { codemode: false as const },
        async execute(input, toolContext) {
          const args = input as { question: string; model?: string }
          void toolContext.progress({ title: "Consulting the oracle" })
          return { content: await askOracle(host, toolContext.sessionID, args) }
        },
      })
    })

    if (goalEnabled) void resumeRunningGoals(host)

    return async () => {
      await tools.dispose()
      await rpc.dispose()
    }
  },
})
