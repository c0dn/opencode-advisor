import type { Host, ModelRef } from "./host.ts";

const projectKey = (project: string) => `advisor.model.project:${project}`;
const GLOBAL_KEY = "advisor.model.global";

/** `provider/model` or `provider/model#variant`, as opencode.json spells a model. */
export function parseModel(spec: string): ModelRef {
  const trimmed = spec.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    throw new Error(`Expected provider/model[#variant], got "${spec}"`);
  }
  const providerID = trimmed.slice(0, slash);
  const [id, variant] = trimmed.slice(slash + 1).split("#", 2) as [string, string | undefined];
  return variant ? { providerID, id, variant } : { providerID, id };
}

/** How an advisor model reads in replies. */
export const describeModel = (spec?: string) => spec ?? "OpenCode's default model";

export function formatModel(model: ModelRef): string {
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`;
}

export type ModelSource = "project" | "global" | "opencode.json" | "default";

/**
 * The advisor model, first set of: /advisor for this project, /advisor --global,
 * the plugin option. Without any, `spec` is absent and OpenCode's default model answers.
 */
export async function resolveAdvisorModel(host: Host): Promise<{ spec?: string; source: ModelSource }> {
  const project = await host.storage.get(projectKey(host.project));
  if (typeof project === "string") return { spec: project, source: "project" };
  const global = await host.storage.get(GLOBAL_KEY);
  if (typeof global === "string") return { spec: global, source: "global" };
  const option = host.options.advisorModel;
  if (typeof option === "string") return { spec: option, source: "opencode.json" };
  return { source: "default" };
}

export async function setAdvisorModel(host: Host, spec: string, scope: "project" | "global"): Promise<void> {
  parseModel(spec);
  await host.storage.set(scope === "project" ? projectKey(host.project) : GLOBAL_KEY, spec.trim());
}

export async function resetAdvisorModel(host: Host, scope: "project" | "global"): Promise<void> {
  await host.storage.remove(scope === "project" ? projectKey(host.project) : GLOBAL_KEY);
}

const enabledKey = (host: Host, scope: "project" | "global") =>
  scope === "project" ? `advisor.enabled.project:${host.project}` : "advisor.enabled.global";

export async function advisorEnabled(host: Host): Promise<{ enabled: boolean; source: string }> {
  for (const scope of ["project", "global"] as const) {
    const value = await host.storage.get(enabledKey(host, scope));
    if (typeof value === "boolean") return { enabled: value, source: scope };
  }
  return { enabled: true, source: "default" };
}

export async function setAdvisorEnabled(host: Host, enabled: boolean, scope: "project" | "global"): Promise<void> {
  await host.storage.set(enabledKey(host, scope), enabled);
}

export async function resetAdvisorEnabled(host: Host, scope: "project" | "global"): Promise<void> {
  await host.storage.remove(enabledKey(host, scope));
}

export async function requireAdvisor(host: Host): Promise<void> {
  if (!(await advisorEnabled(host)).enabled) throw new Error("Advisor consultations are disabled. Use /advisor on to enable them. Goal judging is controlled separately by external_judge.");
}
