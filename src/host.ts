/**
 * What the advisor and the goal loop need from the plugin runtime, narrowed to
 * plain functions so the core stays independent of the V2 SDK's types.
 */
export interface ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

export interface Host {
  /** Plugin unload stops controllers without changing persisted goals or jobs. */
  signal?: AbortSignal;
  /** The session's model context: what its next request would carry. */
  context(sessionID: string): Promise<readonly unknown[]>;
  /** One completion with no tools, on `model` (the default model when absent). */
  generate(prompt: string, model?: ModelRef): Promise<string>;
  /** Adds a synthetic message and starts an agent turn from it. */
  turn(sessionID: string, text: string): Promise<void>;
  /** Shows a notice to the user without adding it to the model's context. */
  notify(sessionID: string, text: string): Promise<void>;
  /** Resolves once the session is idle. */
  wait(sessionID: string): Promise<void>;
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
    scan(prefix: string): Promise<readonly { key: string; value: unknown }[]>;
  };
  /** Project root, the key for per-project settings. */
  project: string;
  /** This plugin's options from opencode.json. */
  options: Readonly<Record<string, unknown>>;
}
