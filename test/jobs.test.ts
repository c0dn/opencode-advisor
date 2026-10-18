import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exitMarker, jobState, loadGoal, resumeRunningGoals, waitForDependencies, type JobDependency } from "../src/goal.ts";
import type { Host } from "../src/host.ts";
import { hostProbe, type Probe } from "../src/probe.ts";

type Message = Record<string, unknown>;

/** Real filesystem reads, scripted server identity, process and unit state. */
function fakeProbe(over: Partial<Probe> = {}) {
  const state = { server: "srv-1", procs: new Map<number, string>(), units: new Map<string, string>() };
  const probe: Probe = {
    serverID: () => state.server,
    exists: hostProbe.exists,
    size: hostProbe.size,
    read: hostProbe.read,
    processStart: (pid) => state.procs.get(pid),
    unitState: async (unit) => state.units.get(unit),
    ...over,
  };
  return { probe, state };
}

function fakeHost(probe: Probe) {
  const messages: Message[] = [];
  const store = new Map<string, unknown>();
  const turns: string[] = [];
  const notices: string[] = [];
  const prompts: string[] = [];
  const host: Host = {
    context: async () => [...messages],
    generate: async (prompt) => { prompts.push(prompt); return JSON.stringify({ done: true, summary: "ok" }); },
    turn: async (_s, text) => { turns.push(text); },
    notify: async (_s, text) => { notices.push(text); },
    wait: async () => {},
    storage: {
      get: async (k) => structuredClone(store.get(k)),
      set: async (k, v) => void store.set(k, structuredClone(v)),
      remove: async (k) => void store.delete(k),
      scan: async (p) => [...store].filter(([k]) => k.startsWith(p)).map(([key, value]) => ({ key, value })),
    },
    project: "/proj",
    options: {},
    probe,
    jobPollMs: 10,
  };
  store.set("goal:s1", { sessionID: "s1", text: "finish training", status: "running", round: 0, maxRounds: null, started: 1, feedback: [] });
  return { host, messages, store, turns, notices, prompts };
}

const until = async (check: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await Bun.sleep(10); }
  throw new Error("condition not reached");
};
/** Plays the queued turn: its synthetic message, then an assistant reply. */
const play = (messages: Message[], text: string) => messages.push({ type: "synthetic", text }, { type: "assistant", content: [] });

const dir = () => mkdtempSync(join(tmpdir(), "goal-jobs-"));

describe("exit markers", () => {
  test("last valid marker wins; junk is ignored", () => {
    expect(exitMarker("a\nEXIT=1\nb\nEXIT=0\n", "EXIT=")).toBe(0);
    expect(exitMarker("EXIT=3 trailing\nEXIT=x\n", "EXIT=")).toBeUndefined();
    expect(exitMarker("  EXIT=-9  \n", "EXIT=")).toBe(-9);
    expect(exitMarker("DONE rc=2\n", "DONE rc=")).toBe(2);
  });
});

describe("job state from host facts", () => {
  test("a live unit beats a stale marker; a stopped unit without one is ended", async () => {
    const d = dir(); const log = join(d, "j.log"); writeFileSync(log, "old run\nEXIT=0\n");
    const { probe, state } = fakeProbe();
    const dep: JobDependency = { id: "j", kind: "job", since: 0, log, unit: "oc-j.service", marker: "EXIT=" };
    state.units.set("oc-j.service", "active");
    expect((await jobState(probe, dep)).state).toBe("running");
    state.units.set("oc-j.service", "inactive");
    expect(await jobState(probe, dep)).toMatchObject({ state: "exited", code: 0 });
    writeFileSync(log, "no marker\n");
    expect((await jobState(probe, dep)).state).toBe("ended");
    rmSync(d, { recursive: true });
  });

  test("a reused pid is not the job", async () => {
    const d = dir(); const log = join(d, "j.log"); writeFileSync(log, "training\n");
    const { probe, state } = fakeProbe();
    state.procs.set(42, "999");
    const dep: JobDependency = { id: "j", kind: "job", since: 0, log, pid: 42, start: "123", marker: "EXIT=" };
    expect((await jobState(probe, dep)).state).toBe("ended");
    state.procs.set(42, "123");
    expect((await jobState(probe, dep)).state).toBe("running");
    rmSync(d, { recursive: true });
  });

  test("the real probe sees this process and reads tails", () => {
    expect(hostProbe.processStart(process.pid)).toMatch(/^\d+$/);
    expect(hostProbe.processStart(2 ** 22 + 7)).toBeUndefined();
    const d = dir(); const log = join(d, "t.log"); writeFileSync(log, "x".repeat(100) + "\nEXIT=5\n");
    expect(hostProbe.read(log, 8)).toBe("\nEXIT=5\n");
    rmSync(d, { recursive: true });
  });
});

describe("job waits", () => {
  test("registration validates paths, names and dead jobs", async () => {
    const d = dir();
    const { probe } = fakeProbe();
    const { host } = fakeHost(probe);
    await expect(waitForDependencies(host, "s1", [], "w", 60, [{ name: "a", log: "rel.log" }])).rejects.toThrow("absolute path");
    await expect(waitForDependencies(host, "s1", [], "w", 60, [{ name: "a", log: "/nonexistent-dir-xyz/a.log" }])).rejects.toThrow("existing directory");
    await expect(waitForDependencies(host, "s1", [], "w", 60, [{ name: "bad name", log: join(d, "a.log") }])).rejects.toThrow("unique");
    await expect(waitForDependencies(host, "s1", [], "w", 60, [{ name: "a", log: join(d, "a.log"), pid: 77 }])).rejects.toThrow("no longer running");
    await expect(waitForDependencies(host, "s1", [], "w")).rejects.toThrow("1–20 dependencies");
    await expect(waitForDependencies(host, "s1", [], "w", 30 * 86400 + 1, [{ name: "a", log: join(d, "a.log") }])).rejects.toThrow("timeoutSeconds");
    rmSync(d, { recursive: true });
  });

  test("marker queues one result turn with no model call, then judging resumes", async () => {
    const d = dir(); const log = join(d, "run3.log"); writeFileSync(log, "step 100\n");
    const { probe, state } = fakeProbe();
    state.units.set("oc-run3.service", "active");
    const { host, messages, turns, prompts } = fakeHost(probe);
    await waitForDependencies(host, "s1", [], "training", 3600 * 24 * 10, [{ name: "run3", log, unit: "oc-run3.service" }]);
    await Bun.sleep(80);
    expect(turns).toHaveLength(0);
    appendFileSync(log, "DONE best 0.92\nEXIT=0\n");
    state.units.set("oc-run3.service", "inactive");
    await until(() => turns.length === 1);
    expect(turns[0]).toContain("run3: exited with code 0");
    expect(turns[0]).toContain("DONE best 0.92");
    expect(prompts).toHaveLength(0);
    expect(await loadGoal(host, "s1")).toMatchObject({ status: "running", round: 0 });
    play(messages, turns[0]);
    await until(async () => (await loadGoal(host, "s1"))?.status === "done");
    expect(prompts).toHaveLength(1);
    rmSync(d, { recursive: true });
  });

  test("a job that ends without a marker is reported, not hidden", async () => {
    const d = dir(); const log = join(d, "j.log"); writeFileSync(log, "Traceback: CUDA OOM\n");
    const { probe, state } = fakeProbe();
    state.procs.set(500, "1");
    const { host, turns } = fakeHost(probe);
    await waitForDependencies(host, "s1", [], "eval", 600, [{ name: "eval", log, pid: 500 }]);
    state.procs.delete(500);
    await until(() => turns.length === 1);
    expect(turns[0]).toContain("ENDED WITHOUT A MARKER");
    expect(turns[0]).toContain("CUDA OOM");
    rmSync(d, { recursive: true });
  });

  test("a job finishing while OpenCode is down is picked up on restart, exactly once", async () => {
    const d = dir(); const log = join(d, "j.log"); writeFileSync(log, "");
    const { probe, state } = fakeProbe();
    state.units.set("oc-j.service", "active");
    const { host, turns } = fakeHost(probe);
    const first = new AbortController(); host.signal = first.signal;
    await waitForDependencies(host, "s1", [], "train", 600, [{ name: "j", log, unit: "oc-j.service" }]);
    first.abort();
    await Bun.sleep(30);
    appendFileSync(log, "EXIT=0\n"); state.units.set("oc-j.service", "inactive"); state.server = "srv-2";
    const restarted: Host = { ...host, signal: new AbortController().signal };
    await resumeRunningGoals(restarted);
    await resumeRunningGoals(restarted); // a duplicate load must not queue twice
    await until(() => turns.length >= 1);
    await Bun.sleep(100);
    expect(turns).toHaveLength(1);
    rmSync(d, { recursive: true });
  });
});

describe("lost native dependencies", () => {
  const launch = (id: string, file?: string, created = Date.now()): Message => ({
    type: "assistant", time: { created }, content: [{ type: "tool", name: "shell", state: { status: "completed", metadata: { status: "running", shellID: id },
      content: file ? [{ type: "text", text: `Command moved to the background (shell ID: ${id}).\nOutput is streaming to: ${file}` }] : [] } }],
  });

  test("a server restart marks the shell lost and queues one reconcile; a second loss pauses", async () => {
    const { probe, state } = fakeProbe();
    const { host, messages, turns, notices, prompts } = fakeHost(probe);
    messages.push(launch("sh_poll"));
    await waitForDependencies(host, "s1", ["sh_poll"], "poller");
    await Bun.sleep(50);
    expect(turns).toHaveLength(0);
    state.server = "srv-2";
    await until(() => turns.length === 1, 7000);
    expect(turns[0]).toContain("Reconcile background work");
    expect(turns[0]).toContain("OpenCode restarted");
    expect(notices.at(-1)).toContain("lost a dependency");
    play(messages, turns[0]);
    // The agent wrongly re-waits on the same dead shell.
    await waitForDependencies(host, "s1", ["sh_poll"], "again");
    state.server = "srv-3";
    await until(async () => (await loadGoal(host, "s1"))?.status === "paused", 7000);
    expect((await loadGoal(host, "s1"))?.reason).toContain("lost again");
    expect(prompts).toHaveLength(0);
  }, 20000);

  test("a shell whose output file vanished (eviction) is lost after the grace period", async () => {
    const d = dir(); const out = join(d, "sh_x.out"); writeFileSync(out, "");
    const { probe } = fakeProbe();
    const { host, messages, turns } = fakeHost(probe);
    messages.push(launch("sh_x", out, Date.now() - 60_000));
    await waitForDependencies(host, "s1", ["sh_x"], "poller");
    await Bun.sleep(50);
    expect(turns).toHaveLength(0);
    rmSync(d, { recursive: true });
    await until(() => turns.length === 1, 7000);
    expect(turns[0]).toContain("output file");
  }, 15000);

  test("a fresh shell with no output file yet is not lost", async () => {
    const { probe } = fakeProbe();
    const { host, messages, turns } = fakeHost(probe);
    messages.push(launch("sh_new", "/tmp/definitely-missing-goal-test.out"));
    await waitForDependencies(host, "s1", ["sh_new"], "fresh");
    await Bun.sleep(5300);
    expect(turns).toHaveLength(0);
    expect((await loadGoal(host, "s1"))?.status).toBe("waiting");
    await host.storage.set("goal:s1", { ...(await loadGoal(host, "s1"))!, status: "stopped" });
  }, 10000);
});
