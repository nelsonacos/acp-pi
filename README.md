# acp-pi

An [Agent Client Protocol](https://agentclientprotocol.com) server for [Pi](https://github.com/earendil-works/pi).

It lets any ACP client drive a Pi agent — the same engine behind `gentle-shell` — without
re-implementing Pi's runtime. The first client this targets is Happy's mobile app, whose only
extension surface for custom agents is ACP.

## Why this exists

Two protocols, one gap:

| side | speaks |
|---|---|
| ACP clients (Zed, Happy, others) | ACP over stdio: JSON-RPC 2.0 |
| Pi (`pi`, `gentle-shell`) | RPC over stdio: one JSON object per line |

Pi already ships an interactive client that governs it this way — the Gentle Shell desktop app
launches `pi --mode rpc` and drives it through the same channel. `acp-pi` is the same idea, exposed
in the protocol everyone else speaks.

## Status

Bootstrapping. Nothing runs yet. The design lives in [docs/design.md](docs/design.md) and the work
is tracked in [odd/tasks/acp-bridge.md](odd/tasks/acp-bridge.md).

## Intended usage

```sh
npm install -g acp-pi
# then point the ACP client at:
acp-pi --workspace /path/to/project
```

## What it will not do

- It does not bundle Pi: you install `pi` (or `gentle-shell`) yourself.
- It does not add providers or models: whatever Pi is configured with is what the client sees.
- It does not bypass Pi's permission prompts: ACP permission requests map onto them.

## License

MIT.
