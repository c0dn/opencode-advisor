import { describeModel, parseModel, resolveAdvisorModel } from "./config.ts";
import type { Host } from "./host.ts";
import { renderTranscript } from "./transcript.ts";

const ORACLE_BRIEF = `You are the oracle: a senior engineer consulted by a coding agent for a second opinion.
You see the agent's session transcript below. You cannot run tools or edit files.

- Answer the agent's question directly and specifically. Ground it in the transcript.
- Challenge the plan: look for wrong assumptions, missed edge cases, simpler options, and
  ways the work could be declared done without being verified.
- Recommend one course of action. Say how confident you are and what would change your mind.
- If the transcript lacks something you need, say exactly what to check.
- Never pretend you ran or read something you did not see in the transcript.`;

export interface AskArgs {
  question: string;
  /** Overrides the configured advisor model for this call. */
  model?: string;
}

export async function askOracle(host: Host, sessionID: string, args: AskArgs): Promise<string> {
  const spec = args.model ?? (await resolveAdvisorModel(host)).spec;
  const transcript = renderTranscript(await host.context(sessionID));
  const prompt = `${ORACLE_BRIEF}\n\n# Session transcript\n\n${transcript}\n\n# The agent asks\n\n${args.question}`;
  const answer = await host.generate(prompt, spec ? parseModel(spec) : undefined);
  return `Oracle (${describeModel(spec)}):\n\n${answer.trim()}`;
}
