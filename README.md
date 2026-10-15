# opencode-advisor

An [OpenCode](https://opencode.ai) V2 plugin that gives the agent a second opinion and a way to keep working until a goal is met.

- **Native `advisor` subagent**: foreground or background, with a bounded parent-evidence snapshot and read-only tools. OpenCode owns the child lifecycle and continuation; this plugin supplies evidence and model selection. Configure an `advisor` subagent in your agents directory. The old `oracle_ask` tool is no longer registered.
- **`/advisor`**: shows or sets the advisor model.
- **`/goal <what done looks like>`**: the agent works turn after turn. After each turn the advisor judges from the transcript whether the goal is met, blocked, or still missing something. Rounds are unlimited by default. The loop stops when the goal is done, and pauses when the agent is blocked, makes no progress for 3 rounds, or hits an explicit `-n` round limit.

## Install

```sh
opencode plugin add github:c0dn/opencode-advisor
```

Requires OpenCode 2.0 or later. The package has a server part (the tool, the goal loop and an RPC) and a TUI part (the slash commands, dialogs and toasts). OpenCode loads both automatically.

## Commands

```text
/advisor                                   show the advisor model and where it is set
/advisor <provider/model[#variant]>        set it for this project
/advisor --global <provider/model[#variant]>  set the default for all projects
/advisor reset [--global]                  clear the project (or global) setting

/goal <goal>                               start working autonomously
/goal -n <count> <goal>                   the same, with a round limit
/goal                                      show the current goal
/goal stop                                 drop the goal (the turn in progress finishes)
/goal resume [-n <count>]                 unlimited, or count additional rounds
```

Goals survive an OpenCode restart. Round updates appear as toasts, and as a desktop notification while the terminal is in the background.

## Waiting for background work

When no independent work remains, call
`goal_wait({ids: ["sh_…", "ses_…"], reason: "need training and research results"})`
and end the turn. IDs must come from native background tool launches in the current
session's active context. All listed dependencies must finish and their native
completion messages must be followed by a parent assistant turn before judging
resumes. Waiting uses no model calls or goal rounds and does not enqueue another
parent turn. Failure and cancellation are evidence for the parent, not success.

The default deadline is 24h (`timeoutSeconds`, up to 7 days). Expiry pauses the goal
instead of starting duplicate work. `/goal resume` overrides a wait; `/goal stop`
stops the goal without killing its jobs. Waits persist across plugin restarts. A
missing/compacted completion leaves the goal waiting until its deadline or manual
resume. Use a bounded native shell watcher for independently managed terminals;
do not wait on a persistent dev server itself.

## Consultation boundaries

Each advisor child prompt receives a snapshot of its recorded parent's active
context (after compaction), not arbitrary sessions or hidden reasoning. The snapshot
is capped at 160k characters, with individual results clipped and omissions marked.
Follow-up prompts add only evidence since the saved message boundary (including
that boundary's potentially updated tool results). Compaction that removes the
boundary causes a fresh bounded snapshot. Model/tool steps do not append it again.
An explicit native subagent model override wins over `/advisor` settings.

Advisor and researcher permission hooks deny mutation, shell, nested delegation
and approval-dependent actions. Use read/glob/grep and Jina retrieval; have the
parent run authenticated CLI checks. Configure their agent permissions deny-first
as well. No custom child runner, polling scheduler or log-monitor plugin is needed.

Waiting checks run at most every five seconds without model calls. A completion
delivered without native parent resumption deliberately remains waiting until the
parent handles it or the deadline pauses the goal. Common credential paths are
denied, but read/search access is not an OS sandbox; do not use these roles for
untrusted agents. `src/oracle.ts` is retained as an unregistered legacy helper
and regression fixture, not exposed as a tool.

## Configuration

The advisor model is resolved in this order: the `/advisor` project setting, the `--global` setting, the plugin's `advisorModel` option, then OpenCode's default model. Pick a stronger model than the one doing the work.

```jsonc
{
  "plugins": [{ "package": "@c0dn/opencode-advisor", "options": { "advisorModel": "anthropic/claude-opus-4-1" } }]
}
```

Telling the agent when to use it helps. For example, in `AGENTS.md`:

```md
- Call native `advisor` for consequential uncertainty, repeated failures or independent
  verification; use foreground for blocking decisions, background for independent work.
- Call `goal_wait` before ending a goal turn solely to await native background dependencies.
- A message starting `[goal round N/M]` comes from `/goal`: keep working and show verifiable evidence.
```

## Development

```sh
bun install
bun test
bun run typecheck
```

Point OpenCode at a checkout with a `file://` entry in `opencode.json` `plugins`. Releases are published to npm by GitHub Actions when a GitHub release is created. The tag must match `package.json`'s version, e.g. `v0.1.0`.
