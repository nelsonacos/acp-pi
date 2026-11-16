# acp-pi

An [Agent Client Protocol](https://agentclientprotocol.com) server for [Pi](https://github.com/earendil-works/pi).

It lets any ACP client — Zed, Happy's mobile app, anything that speaks ACP — drive a Pi agent
without re-implementing Pi's runtime. The client sees one agent; behind it, `acp-pi` runs a real
`pi` and translates between the two protocols.

## Requirements

- **Node.js 22.19 or newer.**
- **A working `pi` on your `PATH`**, already logged in. `acp-pi` launches it, so if `pi` cannot
  answer a prompt on its own, the client will not be able to either. To check:

  ```sh
  printf '{"type":"prompt","message":"responde solo: ok"}\n' \
    | pi --mode rpc --no-session
  ```

  If that prints text, you are ready. If it answers `No API key found for the selected model.`,
  fix that in Pi first — see [Credentials](#credentials).

## Install

```sh
npm install -g acp-pi
```

## Quick start

The client launches `acp-pi` itself, so what you configure in the client is the command plus a
workspace. Two things matter more than they look:

1. **Run it from inside the workspace you pass with `--workspace`.**
2. **Make sure `pi` is on the `PATH` your terminal uses.**

```sh
cd /path/to/your/project
acp-pi --workspace /path/to/your/project
```

That runs the bridge on stdio and waits for a client. On its own it prints nothing and exits when
stdin closes — an ACP client is what starts a session.

### Connecting Happy's mobile app

Happy launches the bridge for you, so the command goes after `happy acp --`:

```sh
cd /path/to/your/project
happy acp -- acp-pi --workspace /path/to/your/project
```

The `cd` is not decoration. Happy asks the bridge for a session in **its own working directory**,
and `acp-pi` refuses a session outside the workspace it was given. Run the command from the
project you are passing and the two agree; run it from anywhere else and the session fails.

When the session opens, the phone shows the models your Pi is configured with, streams replies as
they are produced, and can switch models.

## Credentials

`acp-pi` does not manage credentials: the `pi` it launches reads them the way Pi always does.

Pi looks in `~/.pi/agent` unless `PI_CODING_AGENT_DIR` says otherwise. If your keys live somewhere
else — `gentle-shell`, for instance, keeps its own agent directory — point Pi at it **before**
starting the client, because the bridge inherits the environment you launch it with:

```sh
export PI_CODING_AGENT_DIR="$HOME/.gentle-shell/agent"
```

Without that, Pi still starts and still lists its models, and then refuses the first prompt with
`No API key found for the selected model.` The bridge relays that sentence to the client, so the
client shows it as-is instead of a generic error.

## Configuration

Everything is an environment variable; there are no config files.

| variable | default | what it does |
|---|---|---|
| `ACP_PI_COMMAND` | `["pi","--mode","rpc","--no-session"]` | The full command `acp-pi` runs, as a **JSON array**. A plain path here is a mistake and is rejected at startup. |
| `ACP_PI_TURN_TIMEOUT_MS` | `600000` | How long a single prompt may run before it is abandoned. |
| `ACP_PI_COMMAND_TIMEOUT_MS` | `10000` | How long Pi has to answer a control command, such as listing its models. |
| `ACP_PI_DEBUG` | unset | When set to any value, traces each incoming method, its parameters, and any exception with its stack to stderr. Silent otherwise. |

Example, with a Pi installed somewhere unusual:

```sh
export ACP_PI_COMMAND='["/opt/pi/bin/pi","--mode","rpc","--no-session"]'
```

## Troubleshooting

| what you see | what it means |
|---|---|
| `No API key found for the selected model.` | Pi has no credentials. See [Credentials](#credentials). |
| `Internal error` with no detail | The client is trimming the error. Set `ACP_PI_DEBUG=1`, reproduce, and read the trace — Pi's own message is in it. |
| `No commits` / the session never opens | The client's working directory is outside `--workspace`. Start both from the same directory. |
| `pi: command not found` | `pi` is not on the `PATH` of the process that launched the bridge. Use an absolute path in `ACP_PI_COMMAND`, or fix the `PATH`. |
| The client shows no models | Pi reported no active model. Run `pi` once and pick a model; `acp-pi` announces what Pi reports and never invents an entry. |

Where to find the trace: with `ACP_PI_DEBUG=1`, `acp-pi` writes to **stderr**, and clients capture
that into their own logs. Happy, for example, keeps it in `~/.happy/logs/`.

## What it does not do

- **One session per process.** A second `session/new` on the same bridge is refused; start another
  process instead.
- **Text prompts only.** Attachments and non-text content blocks are rejected rather than dropped.
- **No credentials, no models of its own.** Whatever Pi is configured with is exactly what the
  client sees.
- **No permission bypass.** If Pi asks before running something, the client is asked and its answer
  is what Pi receives. If Pi does not ask, there is nothing to confirm — `acp-pi` does not add
  approval steps of its own.

## How it works

```text
ACP client  ──ACP over stdio──▶  acp-pi  ──Pi RPC over stdio──▶  pi
```

ACP is JSON-RPC 2.0 framed by the protocol; Pi speaks one JSON object per line. The bridge spawns
`pi --mode rpc --no-session`, forwards prompts, streams Pi's output back as `session/update`
messages, and maps Pi's confirmation dialogs onto ACP permission requests.

The design notes are in [docs/design.md](docs/design.md).

## License

MIT.
