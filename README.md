# opencode-advisor

An [OpenCode](https://opencode.ai) V2 plugin that gives the agent a second opinion and a way to keep working until a goal is met.

- **`oracle_ask`**: a tool the agent calls to ask a stronger, independent model about the current session. The advisor reads the whole transcript and answers one question.
- **`/advisor`**: shows or sets the advisor model.
- **`/goal <what done looks like>`**: the agent works turn after turn. After each turn the advisor judges from the transcript whether the goal is met, blocked, or still missing something. The loop stops when the goal is done, and pauses when the agent is blocked, makes no progress for 3 rounds, or hits the round limit (15 by default).

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
/goal --rounds <n> <goal>                  the same, with a round limit
/goal                                      show the current goal
/goal stop                                 drop the goal (the turn in progress finishes)
/goal resume [--rounds <n>]                continue a paused goal
```

Goals survive an OpenCode restart. Round updates appear as toasts, and as a desktop notification while the terminal is in the background.

## Configuration

The advisor model is resolved in this order: the `/advisor` project setting, the `--global` setting, the plugin's `advisorModel` option, then OpenCode's default model. Pick a stronger model than the one doing the work.

```jsonc
{
  "plugins": [{ "package": "@c0dn/opencode-advisor", "options": { "advisorModel": "anthropic/claude-opus-4-1" } }]
}
```

Telling the agent when to use it helps. For example, in `AGENTS.md`:

```md
- Call `oracle_ask` before a non-trivial plan, after two failed attempts at the same problem,
  before risky changes, and when unsure the work is done.
- A message starting `[goal round N/M]` comes from `/goal`: keep working and show verifiable evidence.
```

## Development

```sh
bun install
bun test
bun run typecheck
```

Point OpenCode at a checkout with a `file://` entry in `opencode.json` `plugins`. Releases are published to npm by GitHub Actions when a GitHub release is created. The tag must match `package.json`'s version, e.g. `v0.1.0`.
