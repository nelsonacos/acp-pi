# Troubleshooting

Failures worth recognizing on sight, plus how to get a trace when the client only shows a generic
error.

## How to get a real error message

Clients frequently trim error payloads before rendering them, so the useful sentence is lost. The
bridge always sends Pi's own message; to see it, trace the bridge:

```sh
export ACP_PI_DEBUG=1
```

With it set, the bridge writes to **stderr**:

- one line per incoming method (`method session/prompt`);
- the trimmed parameters of the main methods;
- any exception with its name, message and stack.

Nothing goes to stdout, so the protocol is unaffected. Clients usually capture the agent's stderr
into their own log directory — check where your client writes logs, and read the newest file there.

Without the variable, the bridge writes nothing at all.

## Symptoms

### `No API key found for the selected model.`

Pi is installed and starts, but has no credentials for the model that is active.

1. Run Pi by itself and select a model: `pi`, then complete the login flow.
2. If your keys live outside `~/.pi/agent`, export `PI_CODING_AGENT_DIR` **before** starting the
   client. The bridge inherits the environment it was launched with.

More in [credentials](configuration.md#credentials).

### `Internal error` with no detail

The client is showing an error without its payload. This is a symptom, not a cause.

1. Set `ACP_PI_DEBUG=1`.
2. Reproduce the failure.
3. Read the trace: the line after the failing method names the real problem.

Common causes hidden this way: Pi rejecting the prompt, Pi's child process exiting mid-turn, or a
workspace the bridge refused.

### The session never opens

The client asks for a session in **its own working directory**. The bridge accepts only paths inside
`--workspace`, deliberately — it never widens what it was given.

Start the client from the directory you passed:

```sh
cd /path/to/your-project
<client command> -- acp-pi --workspace /path/to/your-project
```

### `pi: command not found`

`pi` is missing from the `PATH` of the process that launched the bridge. A daemon or a mobile client
may have a smaller environment than your shell.

Use an absolute path:

```sh
export ACP_PI_COMMAND='["/absolute/path/to/pi","--mode","rpc","--no-session"]'
```

### `ACP_PI_COMMAND must be a JSON array`

The variable takes an array, not a path. Correct forms:

```sh
export ACP_PI_COMMAND='["pi","--mode","rpc","--no-session"]'
export ACP_PI_COMMAND='["/opt/pi/bin/pi","--mode","rpc","--no-session"]'
```

### The client shows no models

The bridge announces what Pi reports; it invents nothing. An empty list means Pi reported no active
model. Run `pi` once, choose a model, and reconnect.

### A prompt hangs

The turn has a limit: `ACP_PI_TURN_TIMEOUT_MS`, ten minutes by default. If Pi is doing long work,
raise it. If it hangs immediately, check whether `pi` answers the same prompt on its own.

### A prompt fails with an error after the agent worked for a while

If Pi's process died mid-turn, the pending prompt fails with an explicit error instead of waiting
forever. The trace names the exit code and signal. Reproduce with `pi` directly: if it dies there
too, the problem is in Pi or its tooling, not in the bridge.

## Checking the bridge against Pi

Most confusion disappears by comparing the two paths. Ask Pi the same thing directly:

```sh
printf '{"type":"prompt","message":"reply with: ok"}\n' | pi --mode rpc --no-session
```

- **Works here, fails through the client** → environment or workspace: the client launched the
  bridge with a different `PATH`, working directory, or variables.
- **Fails here too** → Pi's own configuration: authentication, model selection, providers.

## Reporting a problem

Include, in this order:

1. The command you used to launch the client, with paths replaced.
2. The client's error as displayed.
3. The relevant lines of the `ACP_PI_DEBUG=1` trace.
4. The output of the direct `pi` check above.
