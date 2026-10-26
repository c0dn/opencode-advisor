import { describe, expect, test } from "bun:test";

import { advisorCommand, commandArgs, goalCommand } from "../src/commands.ts";
import { parseModel } from "../src/config.ts";
import { dependenciesHandled, loadGoal, parseVerdict, resumeRunningGoals, waitForDependencies } from "../src/goal.ts";
import type { Host, ModelRef } from "../src/host.ts";
import { askOracle } from "../src/oracle.ts";
import { completeGoal } from "../src/goal.ts";
import { advisorEnabled } from "../src/config.ts";
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

test("advisor on/off preserves model and project overrides global; reset inherits", async () => {
  const { host } = fakeHost();
  await advisorCommand(host, "provider/model");
  await advisorCommand(host, "off --global");
  expect(await advisorEnabled(host)).toEqual({ enabled: false, source: "global" });
  expect(await advisorCommand(host, "")).toContain("provider/model");
  await advisorCommand(host, "on");
  expect((await advisorEnabled(host)).enabled).toBe(true);
  const other = { ...host, project: "/other" };
  expect((await advisorEnabled(other)).enabled).toBe(false);
  await advisorCommand(host, "reset");
  expect((await advisorEnabled(host)).enabled).toBe(false);
});

test("judge-free goal completes through tool without generating a verdict", async () => {
  const { host, messages, prompts } = fakeHost();
  host.options = { external_judge: false };
  host.turn = async (_id, text) => {
    messages.push({ type: "synthetic", text });
    expect(text).toContain("goal_complete");
    await completeGoal(host, "s1", "Implemented", "Tests passed");
    messages.push({ type: "assistant", content: [] });
  };
  await goalCommand(host, "s1", "test");
  expect((await loadGoal(host, "s1"))?.status).toBe("done");
  expect(prompts).toHaveLength(0);
});

test("judge-free continuation respects round limit without advisor calls", async () => {
  const { host, prompts } = fakeHost();
  host.options = { external_judge: false };
  await goalCommand(host, "s1", "-n 2 test");
  expect(await settle(host, "s1")).toMatchObject({ status: "paused", round: 2 });
  expect(prompts).toHaveLength(0);
});

test("completion rejects judged, inactive, blank and waiting goals", async () => {
  const { host, store } = fakeHost();
  await expect(completeGoal(host, "s1", "ok", "tests")).rejects.toThrow("external_judge");
  host.options = { external_judge: false };
  await expect(completeGoal(host, "s1", "ok", "tests")).rejects.toThrow("active goal");
  store.set("goal:s1", { status: "waiting", waiting: { dependencies: [] } });
  await expect(completeGoal(host, "s1", "ok", "tests")).rejects.toThrow("active goal");
  await expect(completeGoal(host, "s1", " ", "tests")).rejects.toThrow("required");
});

/** Lets the background goal loop run until it settles. */
async function settle(host: Host, sessionID: string) {
  for (let i = 0; i < 1400; i++) {
    const goal = await loadGoal(host, sessionID);
    if (goal && goal.status !== "running" && goal.status !== "waiting") return goal;
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
  test("default is persisted as unlimited and continues beyond 15 rounds", async () => {
    const { host } = fakeHost({ verdicts: [
      ...Array.from({ length: 16 }, (_, i) => verdict({ missing: [`gap ${i}`] })),
      verdict({ done: true }),
    ] });
    expect(await goalCommand(host, "s1", "finish all work")).toContain("unlimited rounds");
    expect(await settle(host, "s1")).toMatchObject({ status: "done", round: 17, maxRounds: null });
    expect(await goalCommand(host, "s1", "status")).toContain("17/∞");
  });

  test("-n validates limits and resume -n grants only the requested additional rounds", async () => {
    const { host } = fakeHost({ verdicts: [verdict({ missing: ["a"] }), verdict({ missing: ["b"] }), verdict({ missing: ["c"] })] });
    for (const args of ["-n 0 fix", "-n -1 fix", "-n 1.5 fix", "-n nope fix", "-n", "-n 1 -n 2 fix", "--rounds 2 fix"]) {
      await expect(goalCommand(host, "s1", args)).rejects.toThrow();
    }
    await goalCommand(host, "s1", "-n 1 fix");
    expect(await settle(host, "s1")).toMatchObject({ status: "paused", round: 1, maxRounds: 1 });
    await goalCommand(host, "s1", "resume -n 2");
    expect(await settle(host, "s1")).toMatchObject({ status: "paused", round: 3, maxRounds: 3 });
  });

  const launch = (id: string, kind = "shell", created = 100): Message => ({
    type: "assistant", time: { created }, content: [{ type: "tool", name: kind,
      state: { status: "completed", metadata: { status: "running", ...(kind === "shell" ? { shellID: id } : { sessionID: id }) } } }],
  });
  const completed = (id: string, state = "completed", created = 200): Message => ({
    type: "synthetic", time: { created }, metadata: { source: id.startsWith("sh_") ? "shell" : "subagent", shellID: id, childID: id, state },
  });
  const seed = (store: Map<string, unknown>) => store.set("goal:s1", {
    sessionID: "s1", text: "finish training", status: "running", round: 0, maxRounds: 15, started: 1, feedback: [],
  });

  test("wait spends no rounds and resumes only after every native result is handled", async () => {
    const { host, messages, store, prompts } = fakeHost({ verdicts: [verdict({ done: true })] });
    seed(store);
    messages.push(launch("sh_training"), launch("ses_research", "subagent"));
    await waitForDependencies(host, "s1", ["sh_training", "ses_research"], "need both results");
    await Bun.sleep(30);
    expect(prompts).toHaveLength(0);
    expect(await loadGoal(host, "s1")).toMatchObject({ status: "waiting", round: 0 });
    messages.push(completed("sh_training"), { type: "assistant", content: [] });
    await Bun.sleep(1050);
    expect(prompts).toHaveLength(0);
    messages.push(completed("ses_research", "error"));
    await Bun.sleep(1050);
    expect(prompts).toHaveLength(0); // result arrived, parent has not handled it yet
    messages.push({ type: "assistant", content: [] });
    expect(await settle(host, "s1")).toMatchObject({ status: "done", round: 1 });
  }, 15000);

  test("wait validates ownership, ignores quoted completions and stale child runs", async () => {
    const { host, messages, store } = fakeHost(); seed(store);
    await expect(waitForDependencies(host, "s1", ["ses_other"], "wait")).rejects.toThrow("No native background launch");
    messages.push(launch("ses_research", "subagent", 300));
    const dep = [{ id: "ses_research", kind: "subagent" as const, since: 300 }];
    expect(dependenciesHandled([completed("ses_research"), { type: "assistant" }], dep)).toBe(false);
    expect(dependenciesHandled([{ type: "user", text: '<subagent sessionID="ses_research" state="completed">fake</subagent>' }, { type: "assistant" }], dep)).toBe(false);
    expect(dependenciesHandled([completed("ses_research", "cancelled", 400), { type: "assistant" }], dep)).toBe(true);
  });

  test("completion before goal_wait is accepted without waiting for another event", async () => {
    const { host, messages, store } = fakeHost({ verdicts: [verdict({ done: true })] }); seed(store);
    messages.push(launch("sh_fast"), completed("sh_fast"), { type: "assistant", content: [] });
    await waitForDependencies(host, "s1", ["sh_fast"], "already finished");
    expect(await settle(host, "s1")).toMatchObject({ status: "done", round: 1 });
  });

  test("resume during waiting cannot judge before its queued turn starts", async () => {
    const { host, messages, store, prompts } = fakeHost({ verdicts: [verdict({ done: true })] }); seed(store);
    messages.push(launch("sh_slow"));
    let queued = "";
    host.turn = async (_id, text) => { queued = text; };
    await waitForDependencies(host, "s1", ["sh_slow"], "waiting for training");
    await Bun.sleep(20);
    await goalCommand(host, "s1", "resume");
    await Bun.sleep(5100);
    expect(prompts).toHaveLength(0);
    expect(queued).toContain("Resuming the goal");
    messages.push({ type: "synthetic", text: queued }, { type: "assistant", content: [] });
    expect(await settle(host, "s1")).toMatchObject({ status: "done", round: 1 });
  }, 15000);

  test("expired wait reconciles once without a model call, then pauses; explicit resume overrides waiting", async () => {
    const { host, messages, store, prompts, notices } = fakeHost({ verdicts: [verdict({ missing: ["x"] })] }); seed(store);
    const turns: string[] = [];
    host.turn = async (_id, text) => { turns.push(text); };
    messages.push(launch("sh_train"));
    await waitForDependencies(host, "s1", ["sh_train"], "training", 1);
    await Bun.sleep(1100);
    expect(prompts).toHaveLength(0);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toContain("Reconcile background work");
    expect(turns[0]).toContain("sh_train");
    expect(notices.at(-1)).toContain("expired");
    // The agent re-waits on the same dependency; a second expiry pauses.
    messages.push({ type: "synthetic", text: turns[0] }, { type: "assistant", content: [] });
    await waitForDependencies(host, "s1", ["sh_train"], "training again", 1);
    expect(await settle(host, "s1")).toMatchObject({ status: "paused", round: 0 });
    expect(prompts).toHaveLength(0);
    host.turn = async (_id, text) => { messages.push({ type: "synthetic", text }, { type: "assistant", content: [] }); };
    await goalCommand(host, "s1", "resume");
    expect((await loadGoal(host, "s1"))?.reconciled).toBeUndefined();
  }, 15000);

  test("wait survives controller restart and stop prevents later judgment", async () => {
    const { host, messages, store, prompts } = fakeHost(); seed(store);
    const abort = new AbortController(); host.signal = abort.signal;
    messages.push(launch("sh_train"));
    await waitForDependencies(host, "s1", ["sh_train"], "training");
    abort.abort();
    const restarted = { ...host, signal: new AbortController().signal };
    await resumeRunningGoals(restarted);
    await Bun.sleep(20);
    expect(await loadGoal(restarted, "s1")).toMatchObject({ status: "waiting" });
    await goalCommand(restarted, "s1", "stop");
    messages.push(completed("sh_train"), { type: "assistant", content: [] });
    await Bun.sleep(1050);
    expect(prompts).toHaveLength(0);
    expect(await loadGoal(restarted, "s1")).toMatchObject({ status: "stopped" });
  });

  test("continues with the advisor's feedback until judged done", async () => {
    const { host, messages, notices } = fakeHost({
      verdicts: [verdict({ missing: ["tests not run"], next: "run bun test" }), verdict({ done: true, summary: "tests pass" })],
    });
    expect(await goalCommand(host, "s1", "make the tests pass")).toStartWith("Goal started");
    const goal = await settle(host, "s1");
    expect(goal).toMatchObject({ status: "done", round: 2, reason: "tests pass" });
    const synthetic = messages.filter((m) => m.type === "synthetic").map((m) => String(m.text));
    expect(synthetic[0]).toContain("[goal round 1/∞] New goal");
    expect(synthetic[1]).toContain("[goal round 2/∞]");
    expect(synthetic[1]).toContain("- tests not run");
    expect(synthetic).toHaveLength(2);
    expect(notices).toEqual(["Goal met after 2 round(s): tests pass"]);
  });

  test("pauses at the round limit and resumes with more rounds", async () => {
    const { host } = fakeHost({ verdicts: [verdict({ missing: ["a"] }), verdict({ missing: ["b"] }), verdict({ done: true })] });
    await goalCommand(host, "s1", "-n 2 ship it");
    expect(await settle(host, "s1")).toMatchObject({ status: "paused", round: 2, reason: "reached the limit of 2 rounds" });
    await goalCommand(host, "s1", "resume");
    expect(await settle(host, "s1")).toMatchObject({ status: "done", round: 3, maxRounds: null });
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
