import { Plugin } from "@opencode/plugin/tui"

import { Advisor } from "./src/rpc.ts"

/** /advisor and /goal: the server plugin does the work, this shows its replies. */
export default Plugin.define({
  id: "opencode-advisor.tui",
  setup(context) {
    const advisor = context.client.rpc(Advisor)

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
        {
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
        },
      ],
    }))

    return advisor.events.on("notice", (event) => {
      const { sessionID, text } = event.data as { sessionID: string; text: string }
      const title = context.data.session.get(sessionID)?.title ?? "Goal"
      context.ui.toast.show({ title, message: text, duration: 10_000 })
      void context.attention.notify({ title: "OpenCode goal", message: text, notification: { when: "blurred" } })
    })
  },
})
