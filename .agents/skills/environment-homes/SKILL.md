---
name: environment-homes
description: "Trigger: a tool reports empty data (no credentials, zero usage, no transcript) or a daemon behaves differently from the shell."
---

## The pattern

Several installations of the same tool can each have a *home*: a directory holding
credentials, models, history. When a process reads the wrong home, the symptom is always
the same and always misleading — the tool looks broken, when it is looking at an empty
directory.

Seen here on three tools, with three different messages:

| tool | message | real cause |
|---|---|---|
| a bridge | `No API key found for the selected model.` | read `~/.pi/agent` instead of the agent's home |
| a cost tracker | `$0.01` instead of `$48.49` | same, for session transcripts |
| a session attach | `no Pi session transcript found` | same, and it blamed `--no-session` |

## Rules

- **Before suspecting a tool, ask which home it read.** Add a trace, read the code, or run
  it with the environment the daemon sees.
- **A daemon inherits nothing.** A process started outside your shell has no exported
  variables. Fix it at the data level (a link) as well as in the shell profile.
- **A variable states intent; a link covers the gaps.** Use both when a tool must work
  from any context.
- **Deduplicate when counting.** With both paths pointing at the same directory,
  iterating both counts every file twice. Compare real paths.
- **Write the revert path down** in the same change that makes the modification.

## Check

Run the tool the way the daemon would (`env -u VAR ...`). If it sees the same data as
your interactive shell, the fix holds.
