#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { agent as createAgent, ndJsonStream } from "@agentclientprotocol/sdk";
import { AcpAgent, toRequestError } from "../lib/acp-agent.mjs";
import {
  debugEnabled,
  debugException,
  debugLog,
  debugParams,
} from "../lib/acp-debug.mjs";

function parseArgs(argv) {
  let workspace;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--workspace") {
      workspace = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--workspace=")) {
      workspace = arg.slice("--workspace=".length);
    }
  }
  return { workspace };
}

function fail(message) {
  process.stderr.write(`acp-pi: ${message}\n`);
  process.exit(2);
}

function parsePositiveInt(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail(`invalid timeout value: ${value}`);
  }
  return parsed;
}

/**
 * The command used to launch Pi. Defaults to `pi --mode rpc --no-session`;
 * `ACP_PI_COMMAND` overrides the full argv (a JSON array), which is how tests
 * inject a fake Pi and how operators point at a specific binary.
 */
function resolvePiCommand() {
  const override = process.env.ACP_PI_COMMAND;
  if (!override) {
    return ["pi", "--mode", "rpc", "--no-session"];
  }
  let parsed;
  try {
    parsed = JSON.parse(override);
  } catch (err) {
    fail(`ACP_PI_COMMAND must be a JSON array: ${err.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    fail('ACP_PI_COMMAND must be a non-empty JSON array, e.g. \'["pi","--mode","rpc","--no-session"]\'');
  }
  return parsed;
}

const { workspace } = parseArgs(process.argv.slice(2));
if (!workspace) {
  fail("missing required option --workspace <dir>");
}
const absWorkspace = resolve(workspace);
if (!existsSync(absWorkspace)) {
  fail(`workspace does not exist: ${workspace}`);
}
if (!statSync(absWorkspace).isDirectory()) {
  fail(`workspace is not a directory: ${workspace}`);
}

const acpAgent = new AcpAgent({
  workspace: absWorkspace,
  piCommand: resolvePiCommand(),
  turnTimeoutMs: parsePositiveInt(
    process.env.ACP_PI_TURN_TIMEOUT_MS,
    600_000,
  ),
  commandTimeoutMs: parsePositiveInt(
    process.env.ACP_PI_COMMAND_TIMEOUT_MS,
    10_000,
  ),
});

// Register the agent-side ACP handlers, then serve stdio. The SDK owns the JSON-RPC
// dispatch and framing; each handler receives the parsed params and a typed client
// context for the client-side methods (`session/update`, `session/request_permission`).
const app = createAgent();

// Every handler goes through the same wrapper: it traces the params and any
// exception when ACP_PI_DEBUG is set, and it keeps Pi's own failure sentence
// visible instead of letting the SDK collapse a throw into a data-less -32603.
const wrap = (method, name) =>
  async (params) => {
    if (debugEnabled()) debugParams(name, params);
    try {
      return await method(params);
    } catch (err) {
      if (debugEnabled()) debugException(name, err);
      throw toRequestError(err);
    }
  };

app.onRequest("initialize", (ctx) => acpAgent.initialize(ctx.params));
app.onRequest("session/new", (ctx) =>
  wrap((params) => acpAgent.newSession(params), "session/new")(ctx.params),
);
app.onRequest("session/prompt", (ctx) =>
  wrap(
    (params) => acpAgent.prompt(params, ctx.client),
    "session/prompt",
  )(ctx.params),
);
// `session/set_model` is an extension the SDK does not know, so it needs an
// explicit params parser; the shape is validated in the agent, which answers
// invalid-params for a malformed model id instead of silently ignoring it.
app.onRequest(
  "session/set_model",
  (params) => params,
  (ctx) =>
    wrap(
      (params) => acpAgent.setSessionModel(params),
      "session/set_model",
    )(ctx.params),
);
app.onNotification("session/cancel", (ctx) =>
  wrap((params) => acpAgent.cancel(params), "session/cancel")(ctx.params),
);

// ACP over stdio is newline-delimited JSON-RPC 2.0; the SDK's ndJsonStream owns
// the framing so the bridge never hand-rolls it. With `ACP_PI_DEBUG` set, the
// streams are wrapped to observe method names (and method-not-found errors) on
// stderr without touching the stdout protocol.
const output = Writable.toWeb(process.stdout);
const input = Readable.toWeb(process.stdin);
const stream = observeStream(ndJsonStream(output, input), output);
app.connect(stream);

/**
 * Wrap the incoming/outgoing ACP streams to trace method names and
 * method-not-found errors on stderr. Disabled (identity) unless ACP_PI_DEBUG.
 */
function observeStream(base, output) {
  if (!debugEnabled()) return base;

  const readable = base.readable.pipeThrough(
    new TransformStream({
      transform(message, controller) {
        if (message && typeof message.method === "string") {
          debugLog(`method ${message.method}`);
        }
        controller.enqueue(message);
      },
    }),
  );

  const textEncoder = new TextEncoder();
  const writable = new WritableStream({
    async write(message) {
      if (isUnknownMethodError(message)) {
        debugLog(`unknown method ${message.error.data.method}`);
      }
      const writer = output.getWriter();
      try {
        await writer.write(
          textEncoder.encode(`${JSON.stringify(message)}\n`),
        );
      } finally {
        writer.releaseLock();
      }
    },
  });

  return { readable, writable };
}

function isUnknownMethodError(message) {
  return (
    message &&
    message.error &&
    message.error.code === -32601 &&
    message.error.data &&
    typeof message.error.data.method === "string"
  );
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await acpAgent.shutdown();
  } catch {
    // Best-effort cleanup on disconnect; nothing left to report to the client.
  }
  process.exit(0);
}

// The ACP client closing stdin is the end of the connection: kill the child if it
// exists and exit cleanly with status 0.
process.stdin.once("end", shutdown);
process.stdin.once("close", shutdown);
process.stdin.on("error", shutdown);
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
