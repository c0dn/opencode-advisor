/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal, onCleanup, Show } from "solid-js"

import type { Goal } from "./goal.ts"

const POLL_MS = 5_000

function shorten(text: string, length: number): string {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > length ? `${line.slice(0, length - 1)}…` : line
}

/** The session's /goal while it is running or paused; hidden otherwise. */
export function GoalSection(props: { context: Context; sessionID: string; status: (sessionID: string) => Promise<Goal | null> }) {
  const theme = props.context.theme
  const [goal, setGoal] = createSignal<Goal | null>(null)

  const refresh = () =>
    props
      .status(props.sessionID)
      .then((value) => setGoal(value && ["running", "waiting", "paused"].includes(value.status) ? value : null))
      .catch(() => setGoal(null))
  void refresh()
  const timer = setInterval(() => void refresh(), POLL_MS)
  onCleanup(() => clearInterval(timer))

  return (
    <Show when={goal()}>
      {(current) => (
        <box flexDirection="column" gap={0} paddingTop={1}>
          <box flexDirection="row" justifyContent="space-between" gap={1}>
            <text fg={theme.text.default} attributes={TextAttributes.BOLD}>
              Goal
            </text>
            <text fg={current().status === "paused" ? theme.text.subdued : theme.text.action.primary.default}>
              {`${current().status} · ${current().round}/${current().maxRounds ?? "∞"}`}
            </text>
          </box>
          <text fg={theme.text.default}>{`  ${shorten(current().text, 34)}`}</text>
          <Show when={current().status !== "running" && current().reason}>
            <text fg={theme.text.subdued}>{`  ${shorten(current().reason ?? "", 34)}`}</text>
          </Show>
        </box>
      )}
    </Show>
  )
}

/** Adds the Goal section to the session sidebar; returns its dispose. */
export function goalSidebar(context: Context, status: (sessionID: string) => Promise<Goal | null>): () => void {
  return context.ui.slot({
    append: "sidebar.content",
    render: (props) => <GoalSection context={context} sessionID={props.sessionID} status={status} />,
  })
}
