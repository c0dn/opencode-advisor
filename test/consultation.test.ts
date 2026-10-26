import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { Host } from "../src/host.ts"
import { installConsultations } from "../src/consultation.ts"

test("native consultation hooks scope evidence, preserve explicit models and deny mutations", async () => {
  const hooks: Record<string, (event: any) => Promise<void>> = {}
  const disposed: string[] = [], reads: string[] = []
  const store = new Map<string, unknown>()
  const evidence = [{ id: "m1", type: "user", text: "parent evidence" }, { id: "m2", type: "user", text: "latest evidence" }]
  const hook = (domain: string) => async (name: string, fn: (event: any) => Promise<void>) => {
    hooks[`${domain}.${name}`] = fn
    return { dispose: async () => { disposed.push(`${domain}.${name}`) } }
  }
  const context = {
    tool: { hook: hook("tool") }, permission: { hook: hook("permission") },
    session: {
      hook: hook("session"),
      get: async ({ sessionID }: { sessionID: string }) => sessionID === "child" ? { agent: "advisor", parentID: "parent" } : { agent: "build" },
      context: async ({ sessionID }: { sessionID: string }) => { reads.push(sessionID); return evidence },
    },
  } as unknown as Plugin.Context
  const host = { project: "/project", storage: { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => { store.set(k, v) } }, options: { advisorModel: "proteus/test" } } as unknown as Host
  const cleanup = await installConsultations(context, host)
  const model: any = { tool: "subagent", input: { agent: "advisor", background: true } }
  await hooks["tool.execute.before"]!(model)
  expect(model.input).toMatchObject({ model: "proteus/test", background: true })
  model.input.model = "explicit/choice"
  await hooks["tool.execute.before"]!(model)
  expect(model.input.model).toBe("explicit/choice")
  store.set("advisor.enabled.project:/project", false)
  await expect(hooks["tool.execute.before"]!(model)).rejects.toThrow("disabled")
  await expect(hooks["tool.execute.before"]!({ tool: "subagent", input: { sessionID: "child" } })).rejects.toThrow("disabled")
  await expect(hooks["session.prompt"]!({ sessionID: "child", prompt: { text: "bypass" } })).rejects.toThrow("disabled")
  await hooks["tool.execute.before"]!({ tool: "subagent", input: { agent: "researcher" } })
  store.set("advisor.enabled.project:/project", true)
  const prompt = { sessionID: "child", prompt: { text: "review this" } }
  await hooks["session.prompt"]!(prompt)
  expect(reads).toEqual(["parent"])
  expect(prompt.prompt.text).toContain("parent evidence")
  expect(prompt.prompt.text).toEndWith("review this")
  await hooks["session.prompt"]!({ sessionID: "other", prompt: { text: "hello" } })
  expect(reads).toEqual(["parent"])
  // A continuation gets a fresh snapshot, not the previous enriched prompt again.
  const followup = { sessionID: "child", prompt: { text: "follow-up" } }
  await hooks["session.prompt"]!(followup)
  expect(followup.prompt.text).toContain("# Parent evidence update")
  expect(followup.prompt.text).not.toContain("\nparent evidence\n")
  expect(followup.prompt.text).toContain("latest evidence")
  for (const agent of ["advisor", "researcher"]) {
    for (const action of ["shell", "edit", "subagent", "question", "fastmail_send_email"]) {
      const event = { agent, action, effect: "allow", resources: ["*"] }
      await hooks["permission.evaluate"]!(event)
      expect(event.effect).toBe("deny")
    }
    const read = { agent, action: "read", effect: "allow", resources: ["/repo/file.ts"] }
    await hooks["permission.evaluate"]!(read)
    expect(read.effect).toBe("allow")
    read.effect = "ask"
    await hooks["permission.evaluate"]!(read)
    expect(read.effect).toBe("deny")
    for (const path of ["/home/u/.ssh/id_rsa", "/repo/.env.local", "/home/u/.local/share/opencode/auth.json", "/home/u/.config/opencode/secrets/token"]) {
      const secret = { agent, action: "read", effect: "allow", resources: [path] }
      await hooks["permission.evaluate"]!(secret)
      expect(secret.effect).toBe("deny")
    }
  }
  await cleanup()
  expect(disposed).toHaveLength(3)
})
