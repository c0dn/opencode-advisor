/**
 * Renders a session's model context as plain text for an advisor model.
 *
 * The messages are read structurally rather than through the SDK's types, so a
 * new message kind degrades to being skipped instead of breaking the build.
 */
type Part = { type?: string; text?: string; name?: string; state?: ToolState };
type ToolState = { status?: string; input?: unknown; content?: unknown; error?: unknown };
type Message = {
  type?: string;
  text?: string;
  description?: string;
  agent?: string;
  name?: string;
  command?: string;
  status?: string;
  exit?: unknown;
  output?: { output?: string };
  summary?: string;
  content?: Part[];
  error?: unknown;
};

const TOOL_OUTPUT_CHARS = 1500;
const TEXT_CHARS = 8000;
/** Roughly 40k tokens: room for the question and an answer in any current model. */
export const TRANSCRIPT_CHARS = 160_000;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… [${text.length - max} more characters]`;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toolContentText(content: unknown): string {
  if (!Array.isArray(content)) return stringify(content ?? "");
  return content
    .map((item) => (item && typeof item === "object" && "text" in item ? String(item.text) : stringify(item)))
    .join("\n");
}

function renderPart(part: Part): string | undefined {
  if (part.type === "text" && part.text) return clip(part.text, TEXT_CHARS);
  if (part.type === "tool") {
    const state = part.state ?? {};
    const input = clip(stringify(state.input ?? {}), 600);
    const result =
      state.status === "error"
        ? `error: ${clip(stringify(state.error), TOOL_OUTPUT_CHARS)}`
        : state.status === "completed"
          ? clip(toolContentText(state.content), TOOL_OUTPUT_CHARS)
          : `(${state.status ?? "pending"})`;
    return `[tool ${part.name ?? "?"}] ${input}\n→ ${result}`;
  }
  return undefined;
}

function renderMessage(message: Message): string | undefined {
  switch (message.type) {
    case "user":
      return `## User\n${clip(message.text ?? "", TEXT_CHARS)}`;
    case "synthetic":
      return `## Note${message.description ? ` (${message.description})` : ""}\n${clip(message.text ?? "", TEXT_CHARS)}`;
    case "skill":
      return `## Skill loaded: ${message.name ?? "?"}`;
    case "shell":
      return `## Shell: ${message.command ?? ""} (${message.status ?? "?"}, exit ${stringify(message.exit ?? "?")})\n${clip(message.output?.output ?? "", TOOL_OUTPUT_CHARS)}`;
    case "compaction":
      return message.summary ? `## Summary of earlier conversation\n${message.summary}` : undefined;
    case "assistant": {
      const parts = (message.content ?? []).map(renderPart).filter((p): p is string => p !== undefined);
      if (message.error) parts.push(`(turn ended with error: ${clip(stringify(message.error), 300)})`);
      return parts.length ? `## Assistant (${message.agent ?? "agent"})\n${parts.join("\n\n")}` : undefined;
    }
    default:
      return undefined;
  }
}

/** The newest messages that fit in `budget` characters, oldest first. */
export function renderTranscript(messages: readonly unknown[], budget = TRANSCRIPT_CHARS): string {
  const rendered: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = renderMessage(messages[i] as Message);
    if (!text) continue;
    if (used + text.length > budget) {
      rendered.push(`[${i + 1} earlier messages omitted]`);
      break;
    }
    rendered.push(text);
    used += text.length;
  }
  return rendered.reverse().join("\n\n");
}

/** True when the newest assistant turn ended in an error, such as an interrupt. */
export function lastTurnFailed(messages: readonly unknown[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Message;
    if (message.type === "assistant") return message.error !== undefined && message.error !== null;
  }
  return false;
}
