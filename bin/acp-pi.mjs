#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  ndJsonStream,
} from "@zed-industries/agent-client-protocol";
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

const agent = new AcpAgent({
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

// ACP over stdio is newline-delimited JSON-RPC 2.0; the SDK's ndJsonStream owns
// the framing so the bridge never hand-rolls it. With `ACP_PI_DEBUG` set, the
// streams are wrapped to observe method names (and method-not-found errors) on
// stderr without touching the stdout protocol.
const output = Writable.toWeb(process.stdout);
const input = Readable.toWeb(process.stdin);
const stream = observeStream(ndJsonStream(output, input), output);
const connection = new AgentSideConnection((conn) => {
  agent.attachConnection(conn);
  return wrapAgentForDebug(agent);
}, stream);

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

/**
 * Wrap the ACP request handlers so ACP_PI_DEBUG records their params and any
 * exception (with stack) before the SDK turns it into a data-less -32603.
 */
function wrapAgentForDebug(agent) {
  const wrap = (method, name) =>
    async (params) => {
      if (debugEnabled()) debugParams(name, params);
      try {
        return await method(params);
      } catch (err) {
        if (debugEnabled()) debugException(name, err);
        // Pi's own sentence is the actionable part of a failure ("No API key
        // found for the selected model."). The SDK would turn a plain throw into
        // a data-less -32603, leaving the client with nothing to show.
        throw toRequestError(err);
      }
    };
  return {
    initialize: agent.initialize.bind(agent),
    newSession: wrap(agent.newSession.bind(agent), "session/new"),
    prompt: wrap(agent.prompt.bind(agent), "session/prompt"),
    cancel: wrap(agent.cancel.bind(agent), "session/cancel"),
    setSessionModel: wrap(
      agent.setSessionModel.bind(agent),
      "session/set_model",
    ),
  };
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await agent.shutdown();
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
