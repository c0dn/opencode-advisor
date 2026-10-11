import { Rpc } from "@opencode/plugin/rpc"

const reply = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
} as const

/**
 * A server plugin command can only answer with a synthetic message, which the
 * TUI shows as its description alone and the model reads in full. So /advisor
 * and /goal are TUI slash commands that call these and show the reply.
 */
export const Advisor = Rpc.define({
  id: "advisor",
  methods: {
    advisor: {
      input: { type: "object", properties: { args: { type: "string" } }, required: ["args"], additionalProperties: false },
      output: reply,
    },
    goal: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" }, args: { type: "string" } },
        required: ["sessionID", "args"],
        additionalProperties: false,
      },
      output: reply,
    },
  },
  events: {
    notice: {
      schema: {
        type: "object",
        properties: { sessionID: { type: "string" }, text: { type: "string" } },
        required: ["sessionID", "text"],
        additionalProperties: false,
      },
    },
  },
})
