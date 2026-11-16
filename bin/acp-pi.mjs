#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { agent as createAgent, ndJsonStream } from "@agentclientprotocol/sdk";
import { AcpAgent } from "../lib/acp-agent.mjs";

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
app.onRequest("initialize", (ctx) => acpAgent.initialize(ctx.params));
app.onRequest("session/new", (ctx) => acpAgent.newSession(ctx.params));
app.onRequest("session/prompt", (ctx) =>
  acpAgent.prompt(ctx.params, ctx.client),
);
app.onNotification("session/cancel", (ctx) => acpAgent.cancel(ctx.params));

// ACP over stdio is newline-delimited JSON-RPC 2.0; the SDK's ndJsonStream owns
// the framing so the bridge never hand-rolls it.
const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);
app.connect(stream);

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
