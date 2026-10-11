import { describe, expect, test } from "bun:test";

import { advisorCommand, commandArgs, goalCommand } from "../src/commands.ts";
import { parseModel } from "../src/config.ts";
import { loadGoal, parseVerdict } from "../src/goal.ts";
import type { Host, ModelRef } from "../src/host.ts";
import { askOracle } from "../src/oracle.ts";
import { lastTurnFailed, renderTranscript } from "../src/transcript.ts";

type Message = Record<string, unknown>;

/**
 * An in-memory session: `synthetic` with resume plays one agent turn, appending
 * whatever `turn` returns; `generate` answers from a script of advisor replies.
 */
function fakeHost(options: { verdicts?: string[]; turn?: () => Message } = {}) {
  const messages: Message[] = [];
  const store = new Map<string, unknown>();
  const prompts: { prompt: string; model?: ModelRef }[] = [];
  const notices: string[] = [];
  const verdicts = [...(options.verdicts ?? [])];
  const turn = options.turn ?? (() => ({ type: "assistant", agent: "build", content: [{ type: "text", text: "worked on it" }] }));
  let idle = Promise.resolve();

  const host: Host = {
    async context() {
      return [...messages];
    },
    async generate(prompt, model) {
      prompts.push({ prompt, model });
      return verdicts.shift() ?? "oracle says hi";
    },
    async turn(_sessionID, text) {
      messages.push({ type: "synthetic", text });
      idle = Promise.resolve().then(() => void messages.push(turn()));
    },
    async notify(_sessionID, text) {
      notices.push(text);
    },
    wait: () => idle,
    storage: {
      get: async (key) => structuredClone(store.get(key)),
      set: async (key, value) => void store.set(key, structuredClone(value)),
      remove: async (key) => void store.delete(key),
      scan: async (prefix) => [...store].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })),
    },
    project: "/proj",
    options: {},
  };
  return { host, messages, notices, prompts, store };
}

const verdict = (v: object) => JSON.stringify({ done: false, blocked: false, summary: "", missing: [], next: "", ...v });

/** Lets the background goal loop run until it settles. */
async function settle(host: Host, sessionID: string) {
  for (let i = 0; i < 200; i++) {
    const goal = await loadGoal(host, sessionID);
    if (goal && goal.status !== "running") return goal;
    await Bun.sleep(5);
  }
  throw new Error("goal loop did not settle");
}

describe("parsing", () => {
  test("model specs", () => {
    expect(parseModel("proteus/gpt-6.1-sol#high")).toEqual({ providerID: "proteus", id: "gpt-6.1-sol", variant: "high" });
    expect(parseModel(" proteus/claude-fable-5-1 ")).toEqual({ providerID: "proteus", id: "claude-fable-5-1" });
    expect(() => parseModel("gpt-5")).toThrow();
  });

  test("verdicts tolerate prose and fences, reject missing done", () => {
    expect(parseVerdict('```json\n{"done": true, "summary": "ok"}\n```')).toMatchObject({ done: true, summary: "ok", missing: [] });
    expect(parseVerdict('{"summary": "no done field"}')).toBeUndefined();
    expect(parseVerdict("not json")).toBeUndefined();
  });

  test("command args drop the command name", () => {
    expect(commandArgs("goal", "/goal make tests pass")).toBe("make tests pass");
    expect(commandArgs("goal", "  make tests pass ")).toBe("make tests pass");
    expect(commandArgs("goal", "/goalkeeper")).toBe("/goalkeeper");
  });
});

describe("transcript", () => {
  test("renders turns and tool calls, newest kept within budget", () => {
    const messages = [
      { type: "user", text: "fix calc" },
      {
        type: "assistant",
        agent: "build",
        content: [
          { type: "text", text: "reading" },
          { type: "tool", name: "read", state: { status: "completed", input: { path: "calc.py" }, content: [{ type: "text", text: "return a - b" }] } },
        ],
      },
    ];
    const text = renderTranscript(messages);
    expect(text).toContain("## User\nfix calc");
    expect(text).toContain('[tool read] {"path":"calc.py"}\n→ return a - b');
    expect(renderTranscript(messages, 40)).toContain("earlier messages omitted");
  });

  test("detects an interrupted last turn", () => {
    expect(lastTurnFailed([{ type: "assistant", content: [], error: { name: "Aborted" } }])).toBe(true);
    expect(lastTurnFailed([{ type: "assistant", content: [] }, { type: "user", text: "hi" }])).toBe(false);
  });
});

describe("advisor", () => {
  test("model resolution: project over global over options over default", async () => {
    const { host } = fakeHost();
    expect(await advisorCommand(host, "")).toContain("OpenCode's default model (from default)");
    await advisorCommand(host, "--global proteus/gpt-6.1-sol#high");
    expect(await advisorCommand(host, "")).toContain("gpt-6.1-sol#high (from global)");
    await advisorCommand(host, "proteus/glm-5.3");
    expect(await advisorCommand(host, "")).toContain("proteus/glm-5.3 (from project)");
    await advisorCommand(host, "reset");
    expect(await advisorCommand(host, "")).toContain("(from global)");
    await expect(advisorCommand(host, "nonsense")).rejects.toThrow();
  });

  test("oracle sends the transcript and question to the configured model", async () => {
    const { host, messages, prompts } = fakeHost();
    messages.push({ type: "user", text: "migrate the db" });
    await advisorCommand(host, "proteus/gpt-6.1-sol#high");
    const answer = await askOracle(host, "s1", { question: "Is dropping the column safe?" });
    expect(answer).toStartWith("Oracle (proteus/gpt-6.1-sol#high):");
    expect(prompts[0]!.model).toEqual({ providerID: "proteus", id: "gpt-6.1-sol", variant: "high" });
    expect(prompts[0]!.prompt).toContain("migrate the db");
    expect(prompts[0]!.prompt).toContain("Is dropping the column safe?");
  });
});

describe("/goal loop", () => {
  test("continues with the advisor's feedback until judged done", async () => {
    const { host, messages, notices } = fakeHost({
      verdicts: [verdict({ missing: ["tests not run"], next: "run bun test" }), verdict({ done: true, summary: "tests pass" })],
    });
    expect(await goalCommand(host, "s1", "make the tests pass")).toStartWith("Goal started");
    const goal = await settle(host, "s1");
    expect(goal).toMatchObject({ status: "done", round: 2, reason: "tests pass" });
    const synthetic = messages.filter((m) => m.type === "synthetic").map((m) => String(m.text));
    expect(synthetic[0]).toContain("[goal round 1/15] New goal");
    expect(synthetic[1]).toContain("[goal round 2/15]");
    expect(synthetic[1]).toContain("- tests not run");
    expect(synthetic).toHaveLength(2);
    expect(notices).toEqual(["Goal met after 2 round(s): tests pass"]);
  });

  test("pauses at the round limit and resumes with more rounds", async () => {
    const { host } = fakeHost({ verdicts: [verdict({ missing: ["a"] }), verdict({ missing: ["b"] }), verdict({ done: true })] });
    await goalCommand(host, "s1", "--rounds 2 ship it");
    expect(await settle(host, "s1")).toMatchObject({ status: "paused", round: 2, reason: "reached the limit of 2 rounds" });
    await goalCommand(host, "s1", "resume");
    expect(await settle(host, "s1")).toMatchObject({ status: "done", round: 3 });
  });

  test("pauses when the same gaps repeat (stall)", async () => {
    const same = verdict({ missing: ["still failing"] });
    const { host } = fakeHost({ verdicts: [same, same, same] });
    await goalCommand(host, "s1", "fix it");
    expect((await settle(host, "s1")).reason).toStartWith("no progress for 3 rounds");
  });

  test("pauses when the agent is blocked or the turn was interrupted", async () => {
    const blocked = fakeHost({ verdicts: [verdict({ blocked: true, next: "needs the API key" })] });
    await goalCommand(blocked.host, "s1", "deploy");
    expect((await settle(blocked.host, "s1")).reason).toBe("the agent is blocked: needs the API key");

    const interrupted = fakeHost({ turn: () => ({ type: "assistant", content: [], error: { name: "Aborted" } }) });
    await goalCommand(interrupted.host, "s1", "deploy");
    expect((await settle(interrupted.host, "s1")).reason).toBe("the last turn was interrupted or ended in an error");
  });

  test("refuses a second goal, and stop wins over a running loop", async () => {
    const { host } = fakeHost({ verdicts: [verdict({ missing: ["x"] })] });
    await goalCommand(host, "s1", "first");
    await expect(goalCommand(host, "s1", "second")).rejects.toThrow("already running");
    expect(await goalCommand(host, "s1", "stop")).toContain("Goal stopped");
    expect(await settle(host, "s1")).toMatchObject({ status: "stopped" });
    expect(await goalCommand(host, "s1", "")).toContain("Goal (stopped");
  });
});
