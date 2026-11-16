# Getting started

From nothing to a client talking to Pi, in four steps. Every command is meant to be copied as is;
replace only the paths in angle brackets.

## 1. Check that Pi works on its own

`acp-pi` runs `pi` and forwards what it returns. If Pi cannot answer by itself, nothing downstream
can. Verify in the same terminal you will use later:

```sh
printf '{"type":"prompt","message":"reply with: ok"}\n' | pi --mode rpc --no-session
```

Expected: a stream of JSON lines that ends with a reply.

If instead you see `pi: command not found`, Pi is not installed or not on this `PATH`. Install it,
or note its absolute path — you will need it in [configuration](configuration.md#the-pi-command).

If you see `No API key found for the selected model.`, Pi is installed but not authenticated. Open
`pi` once, select a model, and complete the login flow. Details in
[credentials](configuration.md#credentials).

## 2. Install the bridge

```sh
npm install -g acp-pi
acp-pi --help
```

`--help` is not implemented; the command prints a usage error and exits 2. That is expected — the
bridge is normally launched by a client, not by hand.

## 3. Point a client at it

Any ACP client accepts a **command** plus, usually, a working directory. Give it:

```
acp-pi --workspace /path/to/your-project
```

And make sure the client's working directory is **inside** `/path/to/your-project`. The bridge
refuses sessions outside the workspace it was given, on purpose: it never widens the directory a
client asks for.

### Happy (mobile)

```sh
cd /path/to/your-project
happy acp -- acp-pi --workspace /path/to/your-project
```

The `cd` matters. Happy requests a session in its own working directory; running the command from
the project makes the two agree.

### Editors and other clients

Configure them the same way: the command above as the agent command, and the project directory as
the workspace.

## 4. Confirm it works

When the session opens, the client should show, in order:

1. **A session** — the connection is accepted.
2. **A model list** — the models your Pi reports, with the active one marked.
3. **A streamed reply** — send any short prompt and watch the text arrive in pieces.

If step 1 fails, the working directory is almost certainly outside `--workspace`.
If step 2 is empty, Pi reports no active model: run `pi` once and pick one.
If step 3 fails, see [troubleshooting](troubleshooting.md).

## Where to go next

- [Configuration](configuration.md) — every environment variable, credentials, timeouts.
- [Troubleshooting](troubleshooting.md) — the failures worth recognizing on sight.
- [Protocol mapping](protocol.md) — what an integrator can expect from each ACP method.
