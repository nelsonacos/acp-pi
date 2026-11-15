# Design: bridging ACP to Pi's RPC mode

## The two contracts

**ACP** (Agent Client Protocol) is JSON-RPC 2.0 over stdio. The client (an editor, a mobile app)
starts the agent process and talks to it. The parts we need:

- `initialize` — capabilities and protocol version handshake.
- `session/new` (or `session/load`) — create a session bound to a workspace directory.
- `session/prompt` — send a user turn; the agent answers with `session/update` notifications.
- `session/cancel` — cancel the current turn.
- `session/request_permission` — the agent asks the client to approve a tool call.
- `session/update` notifications carry streamed content: assistant text chunks, tool calls, tool
  call updates, plans.

**Pi RPC** is JSONL over stdio: one JSON object per line, no framing headers. The agent process is
started with `pi --mode rpc --no-session`, receives commands on stdin and emits events on stdout
until `agent_settled`. Commands we need: `prompt`, `new_session`, `get_state`, `get_messages`,
`set_model`, `cancel`, `bash`, `compact`, `switch_session`, `fork`.

Both sides are newline-delimited JSON on stdio, which is what makes a bridge practical: one process
per ACP session, two pipes, a translation table.

## Architecture

```
ACP client  ──JSON-RPC──▶  acp-pi  ──JSONL──▶  pi --mode rpc
            ◀───────────         ◀────────
```

- One `acp-pi` process per ACP client connection.
- One Pi child process per ACP session, `cwd` set to the ACP workspace root.
- `acp-pi` is a pure translator: it holds no agent state of its own, so a Pi restart is just a new
  child.

## Mapping

| ACP | Pi RPC |
|---|---|
| `initialize` | (none; report Pi's presence and version after `get_state`) |
| `session/new` | spawn `pi --mode rpc --no-session` with `cwd` = workspace |
| `session/load` | spawn with `--session <id>` when Pi can resume it, else report unsupported |
| `session/prompt` | `{"type":"prompt","message":...}` |
| `session/cancel` | cancel the in-flight turn |
| `session/update` (text chunk) | assistant text deltas as Pi emits them |
| `session/update` (tool call) | tool call start/update/end events |
| `session/request_permission` | Pi's confirmation prompt for a tool call |
| model selection | `set_model` |

## Hard problems to solve, in order

1. **Streaming shape.** ACP wants incremental `session/update` notifications; Pi emits events until
   `agent_settled`. The adapter must forward deltas, not wait for the final message.
2. **Permissions.** Pi asks for confirmation through its UI layer. Over RPC, that request has to be
   surfaced as `session/request_permission` and the answer routed back. If this cannot be mapped
   faithfully, the bridge must refuse to auto-approve — a silent "yes" would defeat the permission
   model.
3. **Cancellation.** `session/cancel` must stop the turn and leave the child usable, not kill it.
4. **Errors.** A Pi crash must become an ACP error on the pending request, never a hang.
5. **Workspace confinement.** The child's `cwd` is the ACP workspace; the bridge never widens it.

## Non-goals for the first version

- Multiple concurrent sessions in one process.
- Filesystem and terminal capabilities of ACP (`fs/*`, `terminal/*`): Pi works on its own.
- Any provider configuration: that is Pi's `happy.toml`-free world, and not ours to invent.

## Verification plan

- A fake ACP client that runs a prompt end to end against a real `pi` and asserts streamed chunks,
  a tool call, and a settled session.
- A permission round trip: the fake client answers "deny" and the tool must not execute.
- Cancellation: cancel mid-turn, then run another prompt on the same session and see it work.
