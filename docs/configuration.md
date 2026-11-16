# Configuration

Everything is an environment variable. There is no config file, and no flag besides `--workspace`.

## Command line

| argument | required | meaning |
|---|---|---|
| `--workspace <dir>` | yes | The only directory a session may be opened in. A client asking for any other path is refused. |
| `--workspace=<dir>` | yes | Same, in the `--flag=value` form. |

If the directory does not exist, or is not a directory, the bridge exits with status 2 and a
message naming the path.

## Environment variables

| variable | default | purpose |
|---|---|---|
| `ACP_PI_COMMAND` | `["pi","--mode","rpc","--no-session"]` | The command the bridge runs, as a **JSON array**. |
| `ACP_PI_TURN_TIMEOUT_MS` | `600000` | How long one prompt may run before it is abandoned. |
| `ACP_PI_COMMAND_TIMEOUT_MS` | `10000` | How long Pi has to answer a control command, such as listing its models or reporting state. |
| `ACP_PI_DEBUG` | unset | Any value traces incoming methods, their parameters, and exceptions with stack traces to stderr. |

### The Pi command

`ACP_PI_COMMAND` is a **JSON array**, not a path. A bare path is rejected at startup:

```
acp-pi: ACP_PI_COMMAND must be a JSON array: Unexpected token 'p', "pi" is not valid JSON
```

Use an absolute path when `pi` is not on the `PATH` of the process that launches the bridge:

```sh
export ACP_PI_COMMAND='["/opt/pi/bin/pi","--mode","rpc","--no-session"]'
```

The array form means you can also change how Pi is launched, for example dropping external MCP
servers for a leaner agent:

```sh
export ACP_PI_COMMAND='["pi","--mode","rpc","--no-session","--no-mcp"]'
```

### Timeouts

The two timeouts cover different things and are rarely changed together.

- **Turn timeout** — a single prompt, from request to `end_turn`. Long agent work needs it larger.
- **Command timeout** — short control exchanges with Pi. Raising it only matters on a very slow
  machine.

An abandoned turn is reported to the client as an error; the agent process is not killed.

### Debug tracing

```sh
export ACP_PI_DEBUG=1
```

With it set, stderr receives one line per incoming method, the trimmed parameters of the main
methods, and any exception with its stack. Nothing is written to stdout, so the protocol stays
clean.

This matters because clients often trim error payloads before showing them. A bare
`Internal error` in the client almost always has a full explanation in this trace. Clients usually
capture the agent's stderr into their own log files; check your client's documentation for where.

Without the variable the bridge is completely silent.

## Credentials

`acp-pi` does not manage credentials. The `pi` it launches resolves them exactly as it would if you
had run it yourself.

Pi reads its agent home from `PI_CODING_AGENT_DIR`, falling back to `~/.pi/agent`. If your keys
live elsewhere, export that variable **before** launching the client, because the bridge inherits
the environment it was started with:

```sh
export PI_CODING_AGENT_DIR="$HOME/my-pi-agent-home"
```

Letting Pi resolve its own home is the recommended setup: then nothing extra is needed here, and
`acp-pi` stays out of the way.

When credentials are missing, Pi starts, lists its models, and refuses the first prompt with
`No API key found for the selected model.` The bridge relays that sentence to the client word for
word, so the client shows the real cause instead of a generic failure.

## Relationship to Pi's own settings

The bridge adds nothing to Pi's configuration. Model choice, providers, thinking level, tools and
extensions all come from Pi. If a behavior surprises you, reproduce it by running `pi --mode rpc`
directly: the bridge forwards, it does not reinterpret.
