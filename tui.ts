import { Plugin } from "@opencode/plugin/tui"
import type { KeymapCommand } from "@opencode/plugin/tui/context"

import type { Goal } from "./src/goal.ts"
import { Advisor } from "./src/rpc.ts"
import { goalSidebar } from "./src/sidebar.tsx"

/** /advisor, /goal and the sidebar's Goal section: the server plugin does the work, this shows it. */
export default Plugin.define({
  id: "opencode-advisor.tui",
  async setup(context) {
    const advisor = context.client.rpc(Advisor)
    const features = (await advisor.features({}, { location: context.location ?? context.data.location.default() }).catch(() => ({
      goal: true,
    }))) as { goal: boolean }

    const currentSession = () => {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }
    const locationOf = (sessionID?: string) =>
      (sessionID ? context.data.session.get(sessionID)?.location : undefined) ?? context.location ?? context.data.location.default()

    const show = (title: string, text: string) =>
      text.includes("\n")
        ? context.ui.dialog.alert({ title, message: text })
        : context.ui.toast.show({ title, message: text, duration: 6000 })
    const fail = (title: string, error: unknown) =>
      context.ui.toast.show({ title, message: error instanceof Error ? error.message : String(error), variant: "error" })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "advisor.model",
          title: "Set the advisor model",
          slash: { name: "advisor", arguments: true },
          run: async (input) => {
            const sessionID = currentSession()
            await advisor
              .advisor({ args: input ?? "" }, { location: locationOf(sessionID) })
              .then((reply) => show("Advisor", (reply as { text: string }).text), (error) => fail("Advisor", error))
          },
        },
        ...(!features.goal ? [] : [<KeymapCommand>{
          id: "advisor.goal",
          title: "Work on a goal until it is done",
          slash: { name: "goal", arguments: true },
          run: async (input) => {
            const sessionID = currentSession()
            if (!sessionID) return void context.ui.toast.show({ title: "Goal", message: "Open a session first.", variant: "warning" })
            await advisor
              .goal({ sessionID, args: input ?? "" }, { location: locationOf(sessionID) })
              .then((reply) => show("Goal", (reply as { text: string }).text), (error) => fail("Goal", error))
          },
        }]),
      ],
    }))

    const stopSidebar = features.goal
      ? goalSidebar(context, async (sessionID) =>
          ((await advisor.goalStatus({ sessionID }, { location: locationOf(sessionID) })) as { goal: Goal | null }).goal,
        )
      : () => {}

    const stopNotices = advisor.events.on("notice", (event) => {
      const { sessionID, text } = event.data as { sessionID: string; text: string }
      const title = context.data.session.get(sessionID)?.title ?? "Goal"
      context.ui.toast.show({ title, message: text, duration: 10_000 })
      void context.attention.notify({ title: "OpenCode goal", message: text, notification: { when: "blurred" } })
    })
    return () => {
      stopSidebar()
      stopNotices()
    }
  },
})
