# opencode-auto-memory

> Auto-persistence hook for [opencode](https://opencode.ai) — forces the agent
> to write memory to **both** MCP Serena and a project-local `MEMORY.md` at
> the end of every substantive turn and before every context compaction.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![opencode](https://img.shields.io/badge/opencode-plugin-orange)](https://opencode.ai/docs/plugins/)

## Why this exists

opencode agents, like any LLM-backed assistant, forget everything between
sessions unless memory is explicitly persisted. Manual `write_memory` calls
are easy to skip, especially on long sessions where context compaction
silently drops earlier reasoning.

This plugin enforces a **dual-write** protocol:

1. **MCP Serena** (semantic memory, shared across projects via Serena itself)
2. **`MEMORY.md`** local to the project (plain-text, git-trackable audit log)

Neither channel is optional. The hook makes it impossible for the agent to
wind down a substantive turn without persisting to both.

## Inspiration

This is a functional port of the `memory-guardian.sh` Stop-hook pattern from
Claude Code. Claude Code can return `decision:"block"` from a hook to
re-prompt the model; opencode has no equivalent block mechanism, but the
plugin SDK exposes `client.session.prompt()` inside the `session.idle` event,
which can inject a follow-up prompt into the same session. This plugin reuses
that technique, adapted for auto-persistence instead of iteration.

## How it works

### Triggers

1. **`session.idle`** — fires whenever the agent finishes responding.
   If the turn had substantive work (write/edit/apply_patch tool calls,
   emitted patch parts, or response ≥ 1500 characters), the plugin injects an
   obligatory dual-write prompt via `client.session.prompt()`. The agent then executes `write_memory` on Serena
   and edits `MEMORY.md`, and must finish the response with the literal tag
   `<memory-persisted/>`.

2. **`experimental.session.compacting`** — fires before the session
   compacts its context. The plugin appends a short reminder to
   `output.context` warning that any unpersisted memory is about to be
   lost and dual-write must happen *now*. Non-destructive: preserves the
   default compaction prompt.

### Anti-loop

Per-project state in `.opencode-auto-memory.state.json`:

```json
{
  "persistedSessions": {
    "<sessionID>": { "messageID": "<messageID>", "at": "2026-04-14T19:00:00Z" }
  }
}
```

When the agent's last message contains `<memory-persisted/>`, the plugin
marks the session as persisted and stops re-injecting. Subsequent
`session.idle` events in the same session become no-ops.

### Substantive-work detection

The plugin re-prompts only when **either** condition holds:

- The session history contains any tool call whose name (lowercased) is in
  `{write, edit, apply_patch, patch, multiedit, notebookedit}`.
- The session history contains any emitted `patch` part.
- The last assistant response is ≥ 1500 characters.

Short, read-only turns are ignored — no noise, no unnecessary re-prompts.

## Installation

Requires opencode ≥ 1.4.3. MCP Serena is expected to be configured in your
`opencode.json` if you want the Serena channel to work.

### Option A — symlink install (recommended)

Keeps the plugin versioned in one place; `git pull` updates your live
install automatically.

```bash
git clone https://github.com/daniloaguiarbr/opencode-auto-memory.git \
  ~/.local/share/opencode-auto-memory

mkdir -p ~/.config/opencode/plugin
ln -s ~/.local/share/opencode-auto-memory/plugin/auto-memory.ts \
      ~/.config/opencode/plugin/auto-memory.ts
```

### Option B — copy install

```bash
git clone https://github.com/daniloaguiarbr/opencode-auto-memory.git
cp opencode-auto-memory/plugin/auto-memory.ts ~/.config/opencode/plugin/
```

### SDK dependency

The plugin imports `@opencode-ai/plugin`. opencode installs this SDK
automatically in `~/.config/opencode/node_modules/` the first time you
enable any plugin, so you normally don't need to install it manually.

If it is missing:

```bash
cd ~/.config/opencode && npm install @opencode-ai/plugin
```

## Configuration

Add `.opencode-auto-memory.state.json` to every project's `.gitignore`:

```bash
echo '.opencode-auto-memory.state.json' >> .gitignore
```

### Setting up MCP Serena in opencode

In your `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "serena": {
      "type": "local",
      "command": [
        "uvx", "--from", "git+https://github.com/oraios/serena",
        "serena", "start-mcp-server",
        "--context=claude-code",
        "--enable-web-dashboard", "False"
      ],
      "enabled": true
    }
  }
}
```

## Usage

Once installed, the plugin runs automatically. There is nothing to invoke.

Start a session, make some edits, finish a turn — you'll see the agent
respond with memory persistence instructions, execute `write_memory` and
edit `MEMORY.md`, and close with `<memory-persisted/>`. From that point on,
the session is marked persisted and the plugin stays quiet unless you do
more substantive work.

### Observing plugin activity

The plugin logs to opencode's log service under `service: "opencode-auto-memory"`.
Tail the opencode log file to watch it work.

## Customization

### Tuning the substantive-work threshold

Edit `plugin/auto-memory.ts`:

```ts
const MIN_RESPONSE_CHARS = 1500    // bump up to reduce noise
const WRITE_TOOLS = new Set([...]) // add/remove tools here
```

### Changing the injected prompt

The prompt injected into the session is defined in
`DUAL_WRITE_INSTRUCTIONS` near the top of `plugin/auto-memory.ts`. It is
in Brazilian Portuguese by default (matching the maintainer's agent
workflow). Translate to your working language — the structure
(4 categories, checklist, completion tag) is what matters.

### Switching from symlink to copy install

Just delete the symlink and copy the file:

```bash
rm ~/.config/opencode/plugin/auto-memory.ts
cp ~/.local/share/opencode-auto-memory/plugin/auto-memory.ts \
   ~/.config/opencode/plugin/
```

## Architecture at a glance

| Concern | Claude Code `memory-guardian.sh` | `opencode-auto-memory` |
|---|---|---|
| Language | Bash + Python | TypeScript (Bun runtime) |
| Trigger | `Stop` hook, stdin JSON | `session.idle` + `experimental.session.compacting` |
| Re-prompt mechanism | `{decision:"block", reason:...}` via stdout | `client.session.prompt()` from plugin hook |
| Anti-loop guard | `stop_hook_active` flag in payload | `.state.json` + `<memory-persisted/>` tag |
| Substantive check | ≥ 3000-byte transcript | ≥ 1500-char last response OR write-tool call |
| Dual-write channels | Serena + MEMORY.md | Serena + MEMORY.md |
| Language of prompt | Portuguese (pt-BR) | Portuguese (pt-BR) by default, trivially translatable |

## Troubleshooting

**Plugin doesn't seem to fire.** Verify the symlink exists and the target
file is readable: `ls -la ~/.config/opencode/plugin/auto-memory.ts`. Restart
opencode after (re)installing.

**Plugin loads but never re-prompts.** Ensure your installed version uses the
current SDK request shape: `client.session.messages({ path: { id } })`,
`client.session.prompt({ path: { id }, body: { parts } })`, and
`client.app.log({ body: ... })`. Older variants that called `session.get()`,
`session.send()`, or `app.log()` without `body` can silently no-op against
newer SDK builds.

**Agent ignores the re-prompt.** Check that Serena MCP is actually running
(inspect your opencode logs). Also check the state file — if the session
was already marked persisted, delete the entry to force a re-run.

**Too many re-prompts on trivial turns.** Raise `MIN_RESPONSE_CHARS` or
trim `WRITE_TOOLS` to only the tools that matter to you.

**Loops forever.** The model isn't emitting `<memory-persisted/>`. Check
your system prompt/context — some models drop the literal tag. You can
adapt the marker to any tag your model reliably emits.

## Contributing

Issues and PRs welcome. Keep the plugin single-file and dependency-light —
the whole appeal is drop-in simplicity.

## License

[MIT](LICENSE) © 2026 Danilo Aguiar

## Related projects

- [`opencode-ralph`](https://github.com/rot13maxi/opencode-ralph) — same
  `client.session.send()` technique for iterative Ralph Loop workflows.
- [serena](https://github.com/oraios/serena) — the MCP memory server this plugin persists into.
- [opencode](https://opencode.ai) — the terminal AI coding agent this plugin extends.
