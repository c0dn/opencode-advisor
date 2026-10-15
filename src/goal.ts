import { parseModel, resolveAdvisorModel } from "./config.ts";
import type { Host } from "./host.ts";
import { lastTurnFailed, renderTranscript } from "./transcript.ts";

export type GoalStatus = "running" | "waiting" | "paused" | "done" | "stopped";

export interface Dependency {
  id: string;
  kind: "shell" | "subagent";
  since: number;
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

function kickoffText(goal: Goal): string {
  return `${roundMarker(goal)} New goal. Work on it autonomously until it is fully met and verified.

Goal: ${goal.text}

An independent advisor will judge your progress after each turn from the transcript, so
show your evidence: run the tests or checks that prove each part is done. Don't stop to
ask the user unless you are truly blocked; if you are, say exactly what you need.`;
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
        const latest = await loadGoal(host, sessionID);
        if (latest?.status !== "waiting" || JSON.stringify(latest.waiting) !== JSON.stringify(goal.waiting)) {
          continue;
        }
        if (!dependenciesHandled(messages, goal.waiting.dependencies)) {
          if (Date.now() >= goal.waiting.deadline) return pause(host, goal, "background wait expired; inspect the dependency, then /goal resume");
          // Waiting checks do not call a model, spend rounds, or enqueue parent turns.
          await Bun.sleep(Math.min(WAIT_POLL_MS, Math.max(1, goal.waiting.deadline - Date.now())));
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
  await enqueueTurn(host, goal, kickoffText(goal));
  void run(host, sessionID);
}

export async function resumeGoal(host: Host, sessionID: string, extraRounds?: number): Promise<Goal> {
  const goal = await loadGoal(host, sessionID);
  if (!goal || goal.status === "done" || goal.status === "stopped") throw new Error("No paused goal in this session.");
  if (goal.status === "running") throw new Error("The goal is already running.");
  goal.status = "running";
  goal.reason = undefined;
  goal.waiting = undefined;
  goal.feedback = [];
  goal.maxRounds = extraRounds === undefined ? DEFAULT_MAX_ROUNDS : goal.round + extraRounds;
  const marker = roundMarker(goal);
  await enqueueTurn(host, goal, `${marker} Resuming the goal. Continue from where you left off.\n\nGoal: ${goal.text}`);
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
  content?: { type?: string; name?: string; state?: { status?: string; metadata?: Record<string, unknown> } }[];
};

/** Only native, structured completion metadata counts; quoted XML never does. */
export function dependenciesHandled(messages: readonly unknown[], dependencies: Dependency[]): boolean {
  const rows = messages as EvidenceMessage[];
  return dependencies.every((dep) => {
    const at = rows.findLastIndex((m) => m.type === "synthetic" && m.metadata?.source === dep.kind
      && (dep.kind === "shell" ? m.metadata.shellID : m.metadata.childID) === dep.id
      && ["completed", "error", "cancelled"].includes(m.metadata.state ?? "")
      && (m.time?.created ?? 0) >= dep.since);
    return at >= 0 && rows.slice(at + 1).some((m) => m.type === "assistant");
  });
}

/** Explicit dependencies, not every background process (a dev server may never exit). */
export async function waitForDependencies(host: Host, sessionID: string, ids: string[], reason: string, timeoutSeconds = 86400): Promise<Goal> {
  const goal = await loadGoal(host, sessionID);
  if (!goal || (goal.status !== "running" && goal.status !== "waiting")) throw new Error("No running goal to wait. Start or resume /goal first.");
  if (!ids.length || ids.length > 20 || !reason.trim()) throw new Error("Provide 1–20 dependency IDs and a reason.");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 604800) throw new Error("timeoutSeconds must be 1–604800.");
  const messages = await host.context(sessionID) as EvidenceMessage[];
  const dependencies = [...new Set(ids)].map((id): Dependency => {
    for (const m of [...messages].reverse()) {
      for (const part of [...(m.content ?? [])].reverse()) {
        const meta = part.state?.metadata;
        if (m.type !== "assistant" || part.type !== "tool" || part.state?.status !== "completed" || meta?.status !== "running") continue;
        if ((part.name === "shell" && meta.shellID === id) || (part.name === "subagent" && meta.sessionID === id)) {
          if (!m.time?.created) throw new Error("Dependency launch timestamp is missing; cannot safely bind this wait.");
          return { id, kind: part.name as Dependency["kind"], since: m.time.created };
        }
      }
    }
    throw new Error(`No native background launch for ${id} in this session's active context. Do not guess IDs.`);
  });
  goal.status = "waiting";
  goal.pendingTurn = undefined; // this tool call proves the parent turn has started
  goal.reason = reason.trim();
  goal.waiting = { dependencies, deadline: Date.now() + timeoutSeconds * 1000 };
  await saveGoal(host, goal);
  void run(host, sessionID);
  return goal;
}
