import { describeModel, formatModel, parseModel, resetAdvisorModel, resolveAdvisorModel, setAdvisorModel } from "./config.ts";
import { DEFAULT_MAX_ROUNDS, loadGoal, resumeGoal, startGoal, stopGoal } from "./goal.ts";
import type { Host } from "./host.ts";

/** The command's argument text, without the `/name` a client may leave in front. */
export function commandArgs(name: string, text: string): string {
  return text.replace(new RegExp(`^\\s*/?${name}\\b`), "").trim();
}

export const ADVISOR_USAGE = `/advisor — show the advisor model and where it is set
/advisor <provider/model[#variant]> — set it for this project
/advisor --global <provider/model[#variant]> — set the default for all projects
/advisor reset [--global] — clear the project (or global) setting`;

/** Handles /advisor; returns the reply to show. */
export async function advisorCommand(host: Host, args: string): Promise<string> {
  const words = args.split(/\s+/).filter(Boolean);
  const isGlobal = words.includes("--global");
  const rest = words.filter((w) => w !== "--global");
  const scope = isGlobal ? "global" : "project";

  if (rest.length === 0) {
    const { spec, source } = await resolveAdvisorModel(host);
    return `Advisor model: ${describeModel(spec)} (from ${source}).\n\n${ADVISOR_USAGE}`;
  }
  if (rest[0] === "reset") {
    await resetAdvisorModel(host, scope);
    const { spec, source } = await resolveAdvisorModel(host);
    return `Cleared the ${scope} advisor model. Now using ${describeModel(spec)} (from ${source}).`;
  }
  if (rest[0] === "help") return ADVISOR_USAGE;

  const spec = formatModel(parseModel(rest[0]!));
  await setAdvisorModel(host, spec, scope);
  return `Advisor model set to ${spec} for ${isGlobal ? "all projects" : "this project"}.`;
}

export const GOAL_USAGE = `/goal <what done looks like> — start working autonomously until the advisor judges it met
/goal --rounds <n> <goal> — the same, with a round limit (default ${DEFAULT_MAX_ROUNDS})
/goal — show the current goal
/goal stop — drop the goal (the turn in progress finishes)
/goal resume [--rounds <n>] — continue a paused goal`;

function describe(goal: NonNullable<Awaited<ReturnType<typeof loadGoal>>>): string {
  const reason = goal.reason ? ` — ${goal.reason}` : "";
  return `Goal (${goal.status}, round ${goal.round}/${goal.maxRounds})${reason}\n${goal.text}`;
}

function takeRounds(words: string[]): { rounds?: number; rest: string[] } {
  const at = words.indexOf("--rounds");
  if (at === -1) return { rest: words };
  const rounds = Number(words[at + 1]);
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error("--rounds needs a positive whole number.");
  return { rounds, rest: [...words.slice(0, at), ...words.slice(at + 2)] };
}

/** Handles /goal; returns the reply to show. */
export async function goalCommand(host: Host, sessionID: string, args: string): Promise<string> {
  const { rounds, rest } = takeRounds(args.split(/\s+/).filter(Boolean));
  const verb = rest[0];

  if (!verb || verb === "status") {
    const goal = await loadGoal(host, sessionID);
    return goal ? describe(goal) : `No goal in this session.\n\n${GOAL_USAGE}`;
  }
  if (verb === "help") return GOAL_USAGE;
  if (verb === "stop" && rest.length === 1) {
    const goal = await stopGoal(host, sessionID);
    return goal ? `Goal stopped after ${goal.round} round(s). The turn in progress, if any, will finish.` : "No active goal.";
  }
  if (verb === "resume" && rest.length === 1) {
    const goal = await resumeGoal(host, sessionID, rounds);
    return `Resuming goal at round ${goal.round}/${goal.maxRounds}.`;
  }

  const text = rest.join(" ");
  await startGoal(host, sessionID, text, rounds ?? DEFAULT_MAX_ROUNDS);
  return `Goal started (up to ${rounds ?? DEFAULT_MAX_ROUNDS} rounds): ${text}`;
}
