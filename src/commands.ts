import { describeModel, formatModel, parseModel, resetAdvisorModel, resolveAdvisorModel, setAdvisorModel } from "./config.ts";
import { DEFAULT_MAX_ROUNDS, loadGoal, resumeGoal, startGoal, stopGoal } from "./goal.ts";
import type { Host } from "./host.ts";
import { advisorEnabled, setAdvisorEnabled, resetAdvisorEnabled } from "./config.ts";

/** The command's argument text, without the `/name` a client may leave in front. */
export function commandArgs(name: string, text: string): string {
  return text.replace(new RegExp(`^\\s*/?${name}\\b`), "").trim();
}

export const ADVISOR_USAGE = `/advisor — show the advisor model and where it is set
/advisor <provider/model[#variant]> — set it for this project
/advisor --global <provider/model[#variant]> — set the default for all projects
/advisor on|off [--global] — enable or disable consultations, not goal judging
/advisor reset [--global] — clear model and consultation overrides`;

/** Handles /advisor; returns the reply to show. */
export async function advisorCommand(host: Host, args: string): Promise<string> {
  const words = args.split(/\s+/).filter(Boolean);
  const isGlobal = words.includes("--global");
  const rest = words.filter((w) => w !== "--global");
  const scope = isGlobal ? "global" : "project";

  if (rest.length === 0) {
    const { spec, source } = await resolveAdvisorModel(host);
    const status = await advisorEnabled(host);
    return `Advisor consultations: ${status.enabled ? "on" : "off"} (from ${status.source}).\nAdvisor model: ${describeModel(spec)} (from ${source}).\nGoal external judge: ${host.options.external_judge !== false ? "on" : "off"} (independent).\n\n${ADVISOR_USAGE}`;
  }
  if (rest[0] === "on" || rest[0] === "off") {
    if (rest.length !== 1) throw new Error("Use /advisor on|off [--global].");
    await setAdvisorEnabled(host, rest[0] === "on", scope);
    return `Advisor consultations ${rest[0]} for ${scope}. Selected model preserved; external_judge is unchanged.`;
  }
  if (rest[0] === "reset") {
    await resetAdvisorModel(host, scope);
    await resetAdvisorEnabled(host, scope);
    const { spec, source } = await resolveAdvisorModel(host);
    return `Cleared the ${scope} advisor model. Now using ${describeModel(spec)} (from ${source}).`;
  }
  if (rest[0] === "help") return ADVISOR_USAGE;

  const spec = formatModel(parseModel(rest[0]!));
  await setAdvisorModel(host, spec, scope);
  return `Advisor model set to ${spec} for ${isGlobal ? "all projects" : "this project"}.`;
}

export const GOAL_USAGE = `/goal <what done looks like> — start working autonomously until the advisor judges it met
/goal -n <count> <goal> — set a round limit (default: unlimited)
/goal — show the current goal
/goal stop — drop the goal (the turn in progress finishes)
/goal resume [-n <count>] — continue with unlimited rounds, or at most count additional rounds`;

function describe(goal: NonNullable<Awaited<ReturnType<typeof loadGoal>>>): string {
  const reason = goal.reason ? ` — ${goal.reason}` : "";
  return `Goal (${goal.status}, round ${goal.round}/${goal.maxRounds ?? "∞"})${reason}\n${goal.text}`;
}

function takeRounds(words: string[]): { rounds?: number; rest: string[] } {
  if (words.includes("--rounds") || words.includes("-rounds")) throw new Error("Use -n <count> instead of --rounds.");
  const at = words.indexOf("-n");
  if (at === -1) return { rest: words };
  const rounds = Number(words[at + 1]);
  if (!Number.isSafeInteger(rounds) || rounds < 1 || words.lastIndexOf("-n") !== at) throw new Error("-n needs one positive whole number.");
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
    return `Resuming goal at round ${goal.round}/${goal.maxRounds ?? "∞"}.`;
  }

  const text = rest.join(" ");
  await startGoal(host, sessionID, text, rounds ?? DEFAULT_MAX_ROUNDS);
  return `Goal started (${rounds === undefined ? "unlimited rounds" : `up to ${rounds} rounds`}): ${text}`;
}
