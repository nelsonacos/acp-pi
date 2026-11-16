# Protocol mapping

What an integrator can rely on, and what the bridge does not implement.

Transport: **ACP over stdio**, JSON-RPC 2.0, newline-delimited. One `acp-pi` process serves one
client and one session.

## Agent-side methods

| ACP method | kind | behavior |
|---|---|---|
| `initialize` | request | Validates `protocolVersion` and returns that version with an empty `agentCapabilities` object. An unsupported version is rejected with `invalid params`. |
| `session/new` | request | Spawns Pi inside the requested `cwd` and returns `{ sessionId, models? }`. See [session creation](#session-creation). |
| `session/prompt` | request | Forwards the text to Pi, streams the reply, and resolves with `{ stopReason }` — `end_turn`, or `cancelled` when the turn was aborted. |
| `session/set_model` | request | Switches Pi's active model. Returns `{}` on success, `invalid params` for an unknown or malformed model id. |
| `session/cancel` | notification | Aborts the running turn. The agent process stays alive, so the next prompt works normally. |

`session/set_model` is not part of the ACP core; the bridge registers it explicitly because clients
with a model picker call it.

## Session creation

`session/new` needs a `cwd` inside the workspace the bridge was started with. Outside it, the
request is refused — the bridge never widens the directory it was given.

The response carries the models Pi reports:

```json
{
  "sessionId": "…",
  "models": [
    { "modelId": "provider/model-id", "name": "Human readable name" }
  ]
}
```

`modelId` is `${provider}/${id}`, the pair `session/set_model` accepts back. The list is what Pi
reports at that moment; the bridge adds nothing to it, and **omits the field entirely** when Pi
reports no active model, rather than sending an empty or invented entry.

## Updates sent to the client

Only one kind of session update is produced:

| update | when |
|---|---|
| `agent_message_chunk` | Pi emitted text for the current turn. Updates arrive incrementally, not as one block. |

Tool calls, plans, and thinking traces are not forwarded. A client that renders only
`agent_message_chunk` will show exactly what the bridge sends.

## Permission requests

When Pi asks for confirmation before an action, the bridge sends the client a
`session/request_permission` request with allow/deny options, and passes the client's answer back to
Pi. A denial is honored: the action does not run.

If Pi does not ask, nothing is sent — the bridge does not add approval steps of its own.

## Errors

| situation | error |
|---|---|
| Malformed params, unknown model id, unsupported protocol version | `invalid params`, with a data payload naming the field |
| A method the bridge does not implement | standard JSON-RPC `method not found` |
| Pi rejecting a command | Pi's own message, carried in both `message` and `data.details` |
| Pi's process dying mid-turn | explicit error naming the exit code and signal |

The third row is deliberate: a client that shows only `message` still gets the actionable sentence
(`No API key found for the selected model.`), which is why the bridge does not collapse failures
into a generic internal error.

## What is not implemented

- **Multiple sessions per process.** A second `session/new` is refused; run another process.
- **Attachments.** Non-text prompt content blocks are rejected, not dropped.
- **History and resumption.** A session exists for the lifetime of the process; there is no
  `session/load` and no way to reopen a previous conversation.
- **Pi's own session files.** The bridge runs Pi without session persistence, so nothing is written
  to Pi's session storage.
