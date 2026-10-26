import { dirname, isAbsolute } from "node:path";

import { parseModel, resolveAdvisorModel } from "./config.ts";
import type { Host } from "./host.ts";
import { hostProbe, type Probe } from "./probe.ts";
import { lastTurnFailed, renderTranscript } from "./transcript.ts";

export type GoalStatus = "running" | "waiting" | "paused" | "done" | "stopped";

/** A native background shell or subagent; OpenCode delivers its completion message. */
export interface NativeDependency {
  id: string;
  kind: "shell" | "subagent";
  since: number;
  /** OpenCode server that launched it; a different server means the dependency died with the old one. */
  server?: string;
  /** Shell output file; OpenCode removes it when it drops the shell. */
  file?: string;
}

/** A detached job (systemd unit, setsid process) checked through host state, not OpenCode events. */
export interface JobDependency {
  id: string;
  kind: "job";
  since: number;
  log: string;
  unit?: string;
  pid?: number;
  /** Kernel start time of `pid`, so a reused PID is not mistaken for the job. */
  start?: string;
  marker: string;
}

export type Dependency = NativeDependency | JobDependency;

export interface JobInput {
  name: string;
  log: string;
  unit?: string;
  pid?: number;
  marker?: string;
}

export interface Goal {
  sessionID: string;
  text: string;
  status: GoalStatus;
  /** Rounds judged so far; a round is one agent turn followed by one verdict. */
  round: number;
  /** null means unlimited; JSON-safe for persisted goals. */
  maxRounds: number | null;
  started: number;
  /** The advisor's last few "missing" lists, newest last, for stall detection. */
  feedback: string[];
  /** Why the goal is paused, done or stopped. */
  reason?: string;
  waiting?: { dependencies: Dependency[]; deadline: number };
  /** Unique queued turn identity; survives restart and /goal resume during a wait. */
  pendingTurn?: string;
  /** Dependencies already given a reconcile turn; a second loss or expiry pauses instead. */
  reconciled?: string[];
}

export interface Verdict {
  done: boolean;
  blocked: boolean;
  summary: string;
  missing: string[];
  next: string;
}

export const DEFAULT_MAX_ROUNDS = null;
/** Identical feedback this many rounds in a row means the agent is going in circles. */
const STALL_ROUNDS = 3;
/** How long a resumed turn may take to start before the loop gives up. */
const START_TIMEOUT_MS = 120_000;
const POLL_MS = 1000;
const WAIT_POLL_MS = 5000;
/** Default interval between host checks of detached jobs (systemctl, /proc, log tail). */
const JOB_POLL_MS = 30_000;
/** A shell output file may not exist yet right after launch. */
const LOST_GRACE_MS = 30_000;
const NATIVE_MAX_SECONDS = 604800;
const JOB_MAX_SECONDS = 30 * 86400;

const goalKey = (sessionID: string) => `goal:${sessionID}`;
const controllers = new WeakMap<Host, Set<string>>();

export async function loadGoal(host: Host, sessionID: string): Promise<Goal | undefined> {
  const value = await host.storage.get(goalKey(sessionID));
  return value && typeof value === "object" ? (value as Goal) : undefined;
}

async function saveGoal(host: Host, goal: Goal): Promise<void> {
  await host.storage.set(goalKey(goal.sessionID), goal);
}

const JUDGE_BRIEF = `You judge whether a coding agent has achieved a goal, from its session transcript.
You cannot run anything. Judge only from evidence in the transcript.

- "done" only when every part of the goal is met AND verified in the transcript: tests or
  checks actually run and passing, the requested artifact actually produced. A claim of
  completion without evidence is not done.
- "blocked" when the agent cannot proceed without the user: it asked a question, needs a
  credential, a decision, or access it lacks. Not for ordinary difficulty.
- "missing": the concrete remaining gaps, each one short line. Empty when done.
- "next": the single most useful next step for the agent.

Reply with JSON only, no prose and no code fence:
{"done": boolean, "blocked": boolean, "summary": "one sentence", "missing": ["..."], "next": "..."}`;

export function parseVerdict(text: string): Verdict | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as Partial<Verdict>;
    if (typeof raw.done !== "boolean") return undefined;
    return {
      done: raw.done,
      blocked: raw.blocked === true,
      summary: typeof raw.summary === "string" ? raw.summary : "",
      missing: Array.isArray(raw.missing) ? raw.missing.map(String) : [],
      next: typeof raw.next === "string" ? raw.next : "",
    };
  } catch {
    return undefined;
  }
}

async function judge(host: Host, goal: Goal, messages: readonly unknown[]): Promise<Verdict | undefined> {
  const { spec } = await resolveAdvisorModel(host);
  const prompt = `${JUDGE_BRIEF}\n\n# Goal\n\n${goal.text}\n\n# Session transcript\n\n${renderTranscript(messages)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const verdict = parseVerdict(await host.generate(prompt, spec ? parseModel(spec) : undefined));
    if (verdict) return verdict;
  }
  return undefined;
}

function roundMarker(goal: Goal): string {
  return `[goal round ${goal.round + 1}/${goal.maxRounds ?? "∞"}]`;
}

const selfInstructions = "External judging is disabled. Continue until verified, then call goal_complete with summary and verification evidence. Ending a turn is not completion. Use goal_wait for pending background work; do not duplicate it. If blocked, explain what is needed and ask the user to /goal stop.";

function kickoffText(goal: Goal, host: Host): string {
  return `${roundMarker(goal)} New goal. Work on it autonomously until it is fully met and verified.

Goal: ${goal.text}

${host.options.external_judge === false ? selfInstructions : `An independent advisor will judge your progress after each turn from the transcript, so
show your evidence: run the tests or checks that prove each part is done. Don't stop to
ask the user unless you are truly blocked; if you are, say exactly what you need.`}`;
}

function continueText(goal: Goal, verdict: Verdict): string {
  const missing = verdict.missing.length ? verdict.missing.map((m) => `- ${m}`).join("\n") : "- (not specified)";
  return `${roundMarker(goal)} The advisor judged the goal not met yet. Keep going.

Goal: ${goal.text}

Still missing:
${missing}

Suggested next step: ${verdict.next || "(none)"}`;
}

/** True once the session holds an assistant message after the synthetic message carrying `marker`. */
async function turnStarted(host: Host, sessionID: string, marker: string): Promise<boolean> {
  const messages = (await host.context(sessionID)) as { type?: string; text?: string }[];
  const at = messages.findLastIndex((m) => m.type === "synthetic" && m.text?.includes(marker));
  return at !== -1 && messages.slice(at + 1).some((m) => m.type === "assistant");
}

async function waitForTurn(host: Host, sessionID: string, marker: string): Promise<boolean> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (host.signal?.aborted) return false;
    if (await turnStarted(host, sessionID, marker)) {
      await host.wait(sessionID);
      return true;
    }
    await Bun.sleep(POLL_MS);
  }
  return false;
}

async function pause(host: Host, goal: Goal, reason: string): Promise<void> {
  goal.status = "paused";
  goal.reason = reason;
  await saveGoal(host, goal);
  await host.notify(goal.sessionID, `Goal paused after ${goal.round} round(s): ${reason}\n/goal resume to continue, /goal stop to drop it.`);
}

function stalled(feedback: string[]): boolean {
  if (feedback.length < STALL_ROUNDS) return false;
  const recent = feedback.slice(-STALL_ROUNDS);
  return recent.every((f) => f === recent[0]);
}

/** Drives one goal until it is done, paused or stopped. One loop per session. */
async function run(host: Host, sessionID: string): Promise<void> {
  const active = controllers.get(host) ?? new Set<string>();
  controllers.set(host, active);
  if (active.has(sessionID)) return;
  active.add(sessionID);
  try {
    while (true) {
      if (host.signal?.aborted) return;
      const before = await loadGoal(host, sessionID);
      if (!before || !["running", "waiting"].includes(before.status)) return;
      const marker = before.pendingTurn;
      if (marker) {
        if (!(await waitForTurn(host, sessionID, marker))) {
          if (host.signal?.aborted) return;
          const goal = await loadGoal(host, sessionID);
          if (goal?.status === "running") await pause(host, goal, "the agent's turn did not start");
          return;
        }
      } else {
        await host.wait(sessionID);
      }
      if (host.signal?.aborted) return;

      const goal = await loadGoal(host, sessionID);
      if (!goal || (goal.status !== "running" && goal.status !== "waiting")) return;
      if (goal.pendingTurn !== marker) continue; // a new resume turn has not been observed yet
      if (marker) {
        goal.pendingTurn = undefined;
        await saveGoal(host, goal);
      }

      if (goal.status === "waiting") {
        if (!goal.waiting) return pause(host, goal, "waiting state has no dependencies; /goal resume to recover");
        const messages = await host.context(sessionID);
        const states = await dependencyStates(host, sessionID, messages, goal.waiting.dependencies);
        const latest = await loadGoal(host, sessionID);
        if (latest?.status !== "waiting" || JSON.stringify(latest.waiting) !== JSON.stringify(goal.waiting)) {
          continue;
        }
        const done = new Set(goal.reconciled ?? []);
        const lost = states.filter((s) => s.state === "lost");
        if (lost.length) {
          if (lost.some((s) => done.has(s.dep.id))) {
            return pause(host, goal, `dependency lost again (${lost.map((s) => s.dep.id).join(", ")}); inspect it, then /goal resume`);
          }
          await reconcile(host, goal, lost, "lost");
          continue;
        }
        const open = states.filter((s) => s.state === "pending" || s.state === "running");
        if (open.length) {
          if (Date.now() >= goal.waiting.deadline) {
            if (open.some((s) => done.has(s.dep.id))) return pause(host, goal, "background wait expired; inspect the dependency, then /goal resume");
            await reconcile(host, goal, open, "expired");
            continue;
          }
          // Waiting checks do not call a model, spend rounds, or enqueue parent turns.
          const tick = goal.waiting.dependencies.some((d) => d.kind === "job") ? Math.min(WAIT_POLL_MS, host.jobPollMs ?? JOB_POLL_MS) : WAIT_POLL_MS;
          await Bun.sleep(Math.min(tick, Math.max(1, goal.waiting.deadline - Date.now())));
          continue;
        }
        if (states.some((s) => s.dep.kind === "job")) {
          // No native completion exists for detached jobs: this plugin owns waking the parent.
          goal.status = "running";
          goal.waiting = undefined;
          goal.reason = undefined;
          await enqueueTurn(host, goal, jobResultText(goal, states));
          continue;
        }
        goal.status = "running";
        goal.waiting = undefined;
        goal.reason = undefined;
        await saveGoal(host, goal);
        // Native completion owns waking the parent. Judge only after it handles it.
        await host.wait(sessionID);
      }

      const messages = await host.context(sessionID);
      if (lastTurnFailed(messages)) return pause(host, goal, "the last turn was interrupted or ended in an error");

      if (host.options.external_judge === false) {
        const current = await loadGoal(host, sessionID);
        if (!current || current.status === "done" || current.status === "stopped" || current.status === "paused") return;
        if (current.status === "waiting" || current.pendingTurn) continue;
        current.round += 1;
        if (current.maxRounds != null && current.round >= current.maxRounds) return pause(host, current, `reached the limit of ${current.maxRounds} rounds`);
        await enqueueTurn(host, current, `${roundMarker(current)} Continue toward the goal: ${current.text}\n\n${selfInstructions}`);
        continue;
      }

      const verdict = await judge(host, goal, messages);
      if (host.signal?.aborted) return;
      // A /goal stop while the advisor was thinking wins.
      const current = await loadGoal(host, sessionID);
      if (current?.status === "waiting" || current?.pendingTurn) continue;
      if (!current || current.status !== "running") return;
      if (!verdict) return pause(host, current, "the advisor's verdict could not be parsed twice in a row");

      current.round += 1;
      if (verdict.done) {
        current.status = "done";
        current.reason = verdict.summary;
        await saveGoal(host, current);
        return host.notify(sessionID, `Goal met after ${current.round} round(s): ${verdict.summary}`);
      }
      if (verdict.blocked) return pause(host, current, `the agent is blocked: ${verdict.next || verdict.summary}`);
      current.feedback = [...current.feedback, verdict.missing.join(" | ")].slice(-STALL_ROUNDS);
      if (stalled(current.feedback)) return pause(host, current, `no progress for ${STALL_ROUNDS} rounds: ${verdict.missing.join("; ")}`);
      if (current.maxRounds != null && current.round >= current.maxRounds) return pause(host, current, `reached the limit of ${current.maxRounds} rounds`);

      await enqueueTurn(host, current, continueText(current, verdict));
    }
  } catch (error) {
    if (host.signal?.aborted) return;
    const goal = await loadGoal(host, sessionID).catch(() => undefined);
    if (goal?.status === "running" || goal?.status === "waiting") await pause(host, goal, `the goal loop failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    active.delete(sessionID);
  }
}

async function enqueueTurn(host: Host, goal: Goal, text: string): Promise<void> {
  goal.pendingTurn = `[goal turn ${crypto.randomUUID()}]`;
  await saveGoal(host, goal);
  await host.turn(goal.sessionID, `${text}\n\n${goal.pendingTurn}`);
}

export async function startGoal(host: Host, sessionID: string, text: string, maxRounds: number | null = DEFAULT_MAX_ROUNDS): Promise<void> {
  const existing = await loadGoal(host, sessionID);
  if (existing?.status === "running" || existing?.status === "waiting") {
    throw new Error(`A goal is already running here: "${existing.text}". /goal stop it first.`);
  }
  const goal: Goal = { sessionID, text, status: "running", round: 0, maxRounds, started: Date.now(), feedback: [] };
  await enqueueTurn(host, goal, kickoffText(goal, host));
  void run(host, sessionID);
}

export async function resumeGoal(host: Host, sessionID: string, extraRounds?: number): Promise<Goal> {
  const goal = await loadGoal(host, sessionID);
  if (!goal || goal.status === "done" || goal.status === "stopped") throw new Error("No paused goal in this session.");
  if (goal.status === "running") throw new Error("The goal is already running.");
  goal.status = "running";
  goal.reason = undefined;
  goal.waiting = undefined;
  goal.reconciled = undefined;
  goal.feedback = [];
  goal.maxRounds = extraRounds === undefined ? DEFAULT_MAX_ROUNDS : goal.round + extraRounds;
  const marker = roundMarker(goal);
  await enqueueTurn(host, goal, `${marker} Resuming the goal. Continue from where you left off.\n\nGoal: ${goal.text}${host.options.external_judge === false ? `\n\n${selfInstructions}` : ""}`);
  void run(host, sessionID);
  return goal;
}

export async function stopGoal(host: Host, sessionID: string): Promise<Goal | undefined> {
  const goal = await loadGoal(host, sessionID);
  if (!goal || goal.status === "done" || goal.status === "stopped") return undefined;
  goal.status = "stopped";
  goal.reason = "stopped by the user";
  await saveGoal(host, goal);
  return goal;
}

export async function completeGoal(host: Host, sessionID: string, summary: string, verification: string): Promise<void> {
  if (host.options.external_judge !== false) throw new Error("goal_complete requires external_judge: false.");
  if (!summary.trim() || !verification.trim()) throw new Error("Summary and verification evidence are required.");
  const goal = await loadGoal(host, sessionID);
  if (!goal || goal.status !== "running" || goal.waiting) throw new Error("An active goal with no registered wait is required. Handle dependencies before completing.");
  goal.status = "done";
  goal.reason = `${summary.trim()}\nVerification: ${verification.trim()}`;
  goal.pendingTurn = undefined;
  await saveGoal(host, goal);
  await host.notify(sessionID, `Goal completed by agent: ${goal.reason}`);
}

/** Picks up goals that were running when OpenCode last stopped. */
export async function resumeRunningGoals(host: Host): Promise<void> {
  for (const { value } of await host.storage.scan("goal:")) {
    const goal = value as Goal;
    if (goal?.status === "running" || goal?.status === "waiting") void run(host, goal.sessionID);
  }
}

type EvidenceMessage = {
  type?: string;
  time?: { created?: number };
  metadata?: { source?: string; shellID?: string; childID?: string; state?: string };
  content?: { type?: string; name?: string; content?: { type?: string; text?: string }[]; state?: { status?: string; metadata?: Record<string, unknown>; content?: { type?: string; text?: string }[] } }[];
};

const probeOf = (host: Host): Probe => host.probe ?? hostProbe;

/** True once a native completion for `dep` arrived after its launch and the parent has handled it. */
function nativeHandled(rows: EvidenceMessage[], dep: NativeDependency): boolean {
  const at = rows.findLastIndex((m) => m.type === "synthetic" && m.metadata?.source === dep.kind
    && (dep.kind === "shell" ? m.metadata.shellID : m.metadata.childID) === dep.id
    && ["completed", "error", "cancelled"].includes(m.metadata.state ?? "")
    && (m.time?.created ?? 0) >= dep.since);
  return at >= 0 && rows.slice(at + 1).some((m) => m.type === "assistant");
}

/** Only native, structured completion metadata counts; quoted XML never does. Jobs are not native. */
export function dependenciesHandled(messages: readonly unknown[], dependencies: Dependency[]): boolean {
  const rows = messages as EvidenceMessage[];
  return dependencies.every((dep) => dep.kind !== "job" && nativeHandled(rows, dep));
}

export type DependencyState =
  | { dep: Dependency; state: "handled" | "pending" | "running" }
  | { dep: Dependency; state: "lost"; why: string }
  | { dep: JobDependency; state: "exited"; code: number; tail: string }
  | { dep: JobDependency; state: "ended"; why: string; tail: string };

/** Last `marker<int>` line of a log tail. */
export function exitMarker(text: string, marker: string): number | undefined {
  let code: number | undefined;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.startsWith(marker)) {
      const m = /^(-?\d+)\s*$/.exec(t.slice(marker.length));
      if (m) code = Number(m[1]);
    }
  }
  return code;
}

const TAIL_BYTES = 16384;
function tailLines(probe: Probe, path: string, lines = 20): string {
  return probe.read(path, TAIL_BYTES).split("\n").filter((l, i, all) => l || i < all.length - 1)
    .slice(-lines).map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l)).join("\n");
}

const RUNNING_UNIT = new Set(["active", "activating", "reloading", "deactivating", "refreshing"]);

/** Host facts, not events: survives OpenCode restarts and shell evictions. A live process wins over a stale marker. */
export async function jobState(probe: Probe, dep: JobDependency): Promise<DependencyState> {
  let alive: boolean | undefined;
  if (dep.unit) {
    const state = await probe.unitState(dep.unit);
    if (state !== undefined) alive = RUNNING_UNIT.has(state);
  }
  if (alive === undefined && dep.pid !== undefined) {
    const start = probe.processStart(dep.pid);
    alive = start !== undefined && (dep.start === undefined || start === dep.start);
  }
  if (alive) return { dep, state: "running" };
  const tail = tailLines(probe, dep.log);
  const code = exitMarker(probe.read(dep.log, TAIL_BYTES), dep.marker);
  if (code !== undefined) return { dep, state: "exited", code, tail };
  if (alive === false) {
    return { dep, state: "ended", why: `${dep.unit ? `unit ${dep.unit}` : `pid ${dep.pid}`} is no longer running and ${dep.log} has no ${dep.marker} marker`, tail };
  }
  return { dep, state: "running" };
}

function nativeState(probe: Probe, rows: EvidenceMessage[], dep: NativeDependency): DependencyState {
  if (nativeHandled(rows, dep)) return { dep, state: "handled" };
  const completed = rows.some((m) => m.type === "synthetic" && m.metadata?.source === dep.kind
    && (dep.kind === "shell" ? m.metadata.shellID : m.metadata.childID) === dep.id && (m.time?.created ?? 0) >= dep.since);
  if (completed) return { dep, state: "pending" }; // delivered; the parent has not handled it yet
  if (dep.server && dep.server !== probe.serverID()) {
    return { dep, state: "lost", why: "OpenCode restarted after it launched, so its native completion will never arrive" };
  }
  if (dep.kind === "shell" && dep.file && Date.now() - dep.since > LOST_GRACE_MS && !probe.exists(dep.file)) {
    return { dep, state: "lost", why: `OpenCode dropped the shell (its output file ${dep.file} is gone), so no completion will arrive` };
  }
  return { dep, state: "running" };
}

const jobChecks = new WeakMap<Host, Map<string, { at: number; key: string; states: Map<string, DependencyState> }>>();

async function dependencyStates(host: Host, sessionID: string, messages: readonly unknown[], deps: Dependency[]): Promise<DependencyState[]> {
  const probe = probeOf(host);
  const rows = messages as EvidenceMessage[];
  const cache = jobChecks.get(host) ?? new Map();
  jobChecks.set(host, cache);
  const key = `${sessionID}:${JSON.stringify(deps)}`;
  let entry = cache.get(sessionID);
  const interval = host.jobPollMs ?? JOB_POLL_MS;
  if (deps.some((d) => d.kind === "job") && (!entry || entry.key !== key || Date.now() - entry.at >= interval)) {
    const states = new Map<string, DependencyState>();
    for (const dep of deps) if (dep.kind === "job") states.set(dep.id, await jobState(probe, dep));
    entry = { at: Date.now(), key, states };
    cache.set(sessionID, entry);
  }
  return deps.map((dep) => dep.kind === "job" ? entry!.states.get(dep.id)! : nativeState(probe, rows, dep));
}

function jobResultText(goal: Goal, states: DependencyState[]): string {
  const blocks = states.filter((s) => s.dep.kind === "job").map((s) => {
    const dep = s.dep as JobDependency;
    const head = s.state === "exited" ? `exited with code ${s.code}` : s.state === "ended" ? `ENDED WITHOUT A MARKER: ${s.why}` : s.state;
    const tail = "tail" in s && s.tail ? `\nLast lines of ${dep.log}:\n${s.tail}` : `\nLog: ${dep.log}`;
    return `- ${dep.id}: ${head}${tail}`;
  });
  return `${roundMarker(goal)} Background jobs finished (checked from host state by the goal plugin).

Goal: ${goal.text}

${blocks.join("\n\n")}

Verify the results and artifacts, then continue toward the goal.`.slice(0, 8000);
}

async function reconcile(host: Host, goal: Goal, states: DependencyState[], cause: "lost" | "expired"): Promise<void> {
  goal.reconciled = [...new Set([...(goal.reconciled ?? []), ...states.map((s) => s.dep.id)])];
  goal.status = "running";
  goal.waiting = undefined;
  goal.reason = undefined;
  const lines = states.map((s) => `- ${s.dep.id} (${s.dep.kind}): ${s.state === "lost" ? s.why : `still ${s.state} at the deadline`}${s.dep.kind === "job" ? `; log ${s.dep.log}` : ""}`);
  await host.notify(goal.sessionID, `Goal wait ${cause === "lost" ? "lost a dependency" : "expired"}; queued one reconcile turn.`);
  await enqueueTurn(host, goal, `${roundMarker(goal)} Reconcile background work: the goal wait ${cause === "lost" ? "lost a dependency" : "reached its deadline"}.

Goal: ${goal.text}

${lines.join("\n")}

Check the real state before acting: job logs and EXIT= markers, systemd units, live processes, GPU use and artifacts.
Do not relaunch anything unless the evidence shows it is gone and unfinished. If work is still running,
wait on it again with goal_wait (prefer jobs: for detached work); if it finished, report and continue.
A second loss or expiry of the same dependency pauses the goal.`);
}

const JOB_NAME = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

/** Explicit dependencies, not every background process (a dev server may never exit). */
export async function waitForDependencies(host: Host, sessionID: string, ids: string[], reason: string, timeoutSeconds = 86400, jobs: JobInput[] = []): Promise<Goal> {
  const goal = await loadGoal(host, sessionID);
  if (!goal || (goal.status !== "running" && goal.status !== "waiting")) throw new Error("No running goal to wait. Start or resume /goal first.");
  const total = new Set(ids).size + jobs.length;
  if (!total || total > 20 || !reason.trim()) throw new Error("Provide 1–20 dependencies (ids and/or jobs) and a reason.");
  const max = ids.length ? NATIVE_MAX_SECONDS : JOB_MAX_SECONDS;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > max) {
    throw new Error(`timeoutSeconds must be 1–${max}${ids.length ? " with native ids (job-only waits allow 30 days)" : ""}.`);
  }
  const probe = probeOf(host);
  const server = probe.serverID();
  const messages = await host.context(sessionID) as EvidenceMessage[];
  const native = [...new Set(ids)].map((id): Dependency => {
    for (const m of [...messages].reverse()) {
      for (const part of [...(m.content ?? [])].reverse()) {
        const meta = part.state?.metadata;
        if (m.type !== "assistant" || part.type !== "tool" || part.state?.status !== "completed" || meta?.status !== "running") continue;
        if ((part.name === "shell" && meta.shellID === id) || (part.name === "subagent" && meta.sessionID === id)) {
          if (!m.time?.created) throw new Error("Dependency launch timestamp is missing; cannot safely bind this wait.");
          const text = (part.state?.content ?? part.content ?? []).map((c) => c.text ?? "").join("\n");
          const file = part.name === "shell" ? /Output is streaming to: (\S+\.out)/.exec(text)?.[1] : undefined;
          return { id, kind: part.name as NativeDependency["kind"], since: m.time.created, server, ...(file ? { file } : {}) };
        }
      }
    }
    throw new Error(`No native background launch for ${id} in this session's active context. Do not guess IDs.`);
  });
  const names = new Set<string>();
  const detached: JobDependency[] = [];
  for (const job of jobs) {
    if (!JOB_NAME.test(job.name ?? "") || names.has(job.name)) throw new Error(`Job name "${job.name}" must be unique, 1–64 chars of [A-Za-z0-9._@-].`);
    names.add(job.name);
    if (!isAbsolute(job.log ?? "") || !probe.exists(dirname(job.log))) throw new Error(`Job ${job.name}: log must be an absolute path in an existing directory.`);
    const marker = job.marker ?? "EXIT=";
    if (!marker.trim()) throw new Error(`Job ${job.name}: marker must not be empty.`);
    const dep: JobDependency = { id: job.name, kind: "job", since: Date.now(), log: job.log, marker };
    if (job.unit !== undefined) {
      if (!/^[A-Za-z0-9:_.@\\-]+$/.test(job.unit)) throw new Error(`Job ${job.name}: invalid unit name.`);
      dep.unit = job.unit;
    }
    if (job.pid !== undefined) {
      if (!Number.isInteger(job.pid) || job.pid < 1) throw new Error(`Job ${job.name}: pid must be a positive integer.`);
      dep.pid = job.pid;
      const start = probe.processStart(job.pid);
      if (start !== undefined) dep.start = start;
    }
    // Fail fast on a typo: a job that is neither running nor finished can only time out.
    const state = await jobState(probe, dep);
    if (state.state === "ended") throw new Error(`Job ${job.name}: ${state.why}. Check the unit/pid/log before waiting on it.`);
    detached.push(dep);
  }
  goal.status = "waiting";
  goal.pendingTurn = undefined; // this tool call proves the parent turn has started
  goal.reason = reason.trim();
  goal.waiting = { dependencies: [...native, ...detached], deadline: Date.now() + timeoutSeconds * 1000 };
  await saveGoal(host, goal);
  void run(host, sessionID);
  return goal;
}
