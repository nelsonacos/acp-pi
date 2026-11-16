# acp-pi

An [Agent Client Protocol](https://agentclientprotocol.com) server for [Pi](https://github.com/earendil-works/pi).

It lets any ACP client — an editor, a mobile app, a custom front end — drive a Pi agent without
re-implementing Pi's runtime. The client speaks ACP; behind the scenes `acp-pi` runs a real `pi`
and translates between the two protocols.

```text
ACP client  ──ACP over stdio──▶  acp-pi  ──Pi RPC over stdio──▶  pi
```

**Docs:** [Getting started](docs/getting-started.md) ·
[Configuration](docs/configuration.md) ·
[Troubleshooting](docs/troubleshooting.md) ·
[Protocol mapping](docs/protocol.md)

## Requirements

| requirement | why |
|---|---|
| Node.js **22.19** or newer | the bridge targets modern ESM and streams |
| `pi` on your `PATH`, already authenticated | `acp-pi` launches it; it cannot answer for Pi |

Confirm Pi is ready before blaming the bridge:

```sh
printf '{"type":"prompt","message":"reply with: ok"}\n' | pi --mode rpc --no-session
```

If that prints a reply, you are set. If it prints `No API key found for the selected model.`, fix
that in Pi first — see [credentials](docs/configuration.md#credentials).

## Install

```sh
npm install -g acp-pi
```

## Quick start

```sh
cd /path/to/your-project
acp-pi --workspace /path/to/your-project
```

That starts the bridge on stdio and waits for a client. Run on a terminal with nothing attached it
stays quiet and exits when stdin closes: **an ACP client is what opens a session.**

Two details cause most first-run failures:

1. **Start it from inside the directory you pass to `--workspace`.** Clients request a session in
   *their* working directory, and the bridge refuses one outside the workspace it was given.
2. **`pi` must be on the `PATH` of whatever launches the bridge**, not only of your interactive
   shell.

Full walkthrough: [Getting started](docs/getting-started.md).

## What a client gets

| capability | behavior |
|---|---|
| Models | The session announces the models your Pi reports, with the active one selected |
| Streaming | Pi's output arrives as incremental message updates, not one block at the end |
| Cancellation | Cancelling aborts the turn and keeps the agent alive for the next prompt |
| Permissions | Pi's confirmation dialogs become ACP permission requests; a denial is honored |
| Model switching | The client can switch models; Pi applies the change |

## What it does not do

- **One session per process.** A second `session/new` on the same bridge is refused.
- **Text prompts only.** Non-text content blocks are rejected, never silently dropped.
- **No credentials or models of its own.** Whatever Pi is configured with is what the client sees.
- **No permission step of its own.** If Pi does not ask before running something, the bridge does
  not invent an approval step.

## Configuration

Everything is an environment variable; there are no config files. The full table, defaults and
examples live in [docs/configuration.md](docs/configuration.md).

| variable | default |
|---|---|
| `ACP_PI_COMMAND` | `["pi","--mode","rpc","--no-session"]` (JSON array) |
| `ACP_PI_TURN_TIMEOUT_MS` | `600000` |
| `ACP_PI_COMMAND_TIMEOUT_MS` | `10000` |
| `ACP_PI_DEBUG` | unset |

## Troubleshooting

| symptom | first thing to check |
|---|---|
| `No API key found for the selected model.` | Pi's authentication — see [credentials](docs/configuration.md#credentials) |
| `Internal error` with no detail | Set `ACP_PI_DEBUG=1` and reproduce; the real message is in the trace |
| The session never opens | The client's working directory is outside `--workspace` |
| `pi: command not found` | `pi` is missing from the `PATH` the bridge was started with |
| The client lists no models | Pi reports no active model; run `pi` once and select one |

Full guide with logs and debugging: [Troubleshooting](docs/troubleshooting.md).

## License

MIT.
