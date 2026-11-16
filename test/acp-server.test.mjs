import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const binPath = join(repoRoot, "bin", "acp-pi.mjs");
const fakePiPath = join(__dirname, "fixtures", "fake-pi.mjs");

/** Spawn `acp-pi` against the fake Pi, with optional extra env for the child. */
function spawnAcp(workspace, extraEnv = {}) {
  const env = {
    ...process.env,
    ACP_PI_COMMAND: JSON.stringify([process.execPath, fakePiPath]),
    ...extraEnv,
  };
  const child = spawn(process.execPath, [binPath, "--workspace", workspace], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stderrText = () => stderr;
  return child;
}

/** Minimal JSON-RPC client over the NDJSON stdio the ACP server speaks. */
class JsonRpcClient {
  constructor(child) {
    this.child = child;
    this.messages = [];
    this.waiters = [];
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        this.messages.push(message);
        const waiters = this.waiters;
        this.waiters = waiters.filter((waiter) => !waiter(message));
      }
    });
  }

  send(message) {
    return new Promise((resolvePromise, reject) => {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (err) =>
        err ? reject(err) : resolvePromise(),
      );
    });
  }

  request(id, method, params) {
    return this.send({ jsonrpc: "2.0", id, method, params });
  }

  waitFor(predicate, timeoutMs = 5000) {
    return new Promise((resolvePromise, reject) => {
      const existing = this.messages.find(predicate);
      if (existing !== undefined) return resolvePromise(existing);
      const waiter = (message) => {
        if (predicate(message)) {
          clearTimeout(timer);
          resolvePromise(message);
          return true;
        }
        return false;
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        reject(new Error("timed out waiting for message"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async closeAndWait() {
    this.child.stdin.end();
    return new Promise((resolvePromise) => {
      this.child.once("exit", (code, signal) => resolvePromise({ code, signal }));
    });
  }
}

async function waitForFile(path, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, "utf8");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return null;
}

function makeWorkspace(t) {
  const dir = mkdtempSync(join(tmpdir(), "acp-pi-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("initialize handshake reports protocol version 1", async (t) => {
  const workspace = makeWorkspace(t);
  const child = spawnAcp(workspace);
  const client = new JsonRpcClient(child);
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  await client.request(1, "initialize", { protocolVersion: 1 });
  const response = await client.waitFor((m) => m.id === 1);
  assert.deepEqual(response, {
    jsonrpc: "2.0",
    id: 1,
    result: { protocolVersion: 1, agentCapabilities: {} },
  });

  const { code } = await client.closeAndWait();
  assert.equal(code, 0);
});

test("session/new spawns the pi child in the workspace cwd", async (t) => {
  const workspace = makeWorkspace(t);
  const cwdFile = join(tmpdir(), `acp-pi-cwd-${Date.now()}-${Math.random()}`);
  const child = spawnAcp(workspace, { FAKE_PI_CWD_FILE: cwdFile });
  const client = new JsonRpcClient(child);
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(cwdFile, { force: true });
  });

  await client.request(1, "initialize", { protocolVersion: 1 });
  await client.waitFor((m) => m.id === 1);

  await client.request(2, "session/new", { cwd: workspace, mcpServers: [] });
  const response = await client.waitFor((m) => m.id === 2);
  assert.equal(response.result.sessionId, "fake-session-1");

  const reportedCwd = await waitForFile(cwdFile);
  assert.equal(reportedCwd?.trim(), workspace);

  const { code } = await client.closeAndWait();
  assert.equal(code, 0);
});

test("session/new reports Pi's real models and the active model", async (t) => {
  const workspace = makeWorkspace(t);
  const child = spawnAcp(workspace);
  const client = new JsonRpcClient(child);
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  await client.request(1, "initialize", { protocolVersion: 1 });
  await client.waitFor((m) => m.id === 1);

  await client.request(2, "session/new", { cwd: workspace, mcpServers: [] });
  const response = await client.waitFor((m) => m.id === 2);

  assert.deepEqual(response.result, {
    sessionId: "fake-session-1",
    models: {
      availableModels: [{ modelId: "fake/fake-model", name: "Fake Model" }],
      currentModelId: "fake/fake-model",
    },
  });

  const { code } = await client.closeAndWait();
  assert.equal(code, 0);
});

test("session/new omits models when Pi reports no active model", async (t) => {
  const workspace = makeWorkspace(t);
  const child = spawnAcp(workspace, { FAKE_PI_NO_MODELS: "1" });
  const client = new JsonRpcClient(child);
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  await client.request(1, "initialize", { protocolVersion: 1 });
  await client.waitFor((m) => m.id === 1);

  await client.request(2, "session/new", { cwd: workspace, mcpServers: [] });
  const response = await client.waitFor((m) => m.id === 2);

  // No active model means no honest `models` block: the bridge never invents one.
  assert.deepEqual(response.result, { sessionId: "fake-session-1" });

  const { code } = await client.closeAndWait();
  assert.equal(code, 0);
});

test("session/prompt streams at least two updates and settles on end_turn", async (t) => {
  const workspace = makeWorkspace(t);
  const child = spawnAcp(workspace);
  const client = new JsonRpcClient(child);
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  await client.request(1, "initialize", { protocolVersion: 1 });
  await client.waitFor((m) => m.id === 1);

  await client.request(2, "session/new", { cwd: workspace, mcpServers: [] });
  await client.waitFor((m) => m.id === 2);

  await client.request(3, "session/prompt", {
    sessionId: "fake-session-1",
    prompt: [{ type: "text", text: "hi" }],
  });
  const response = await client.waitFor((m) => m.id === 3);

  assert.deepEqual(response.result, { stopReason: "end_turn" });

  const chunks = client.messages.filter(
    (m) =>
      m.method === "session/update" &&
      m.params?.update?.sessionUpdate === "agent_message_chunk",
  );
  assert.ok(
    chunks.length >= 2,
    `expected at least two streamed agent_message_chunk updates, got ${chunks.length}`,
  );
  assert.ok(
    chunks.every((m) => m.params.sessionId === "fake-session-1"),
    "every update must carry the session id",
  );
  const text = chunks
    .map((m) => m.params.update.content.text)
    .join("");
  assert.equal(text, "Hello world");

  // Streaming must be incremental: updates precede the settled response.
  const responseIndex = client.messages.findIndex((m) => m.id === 3);
  const lastChunkIndex = client.messages.lastIndexOf(
    chunks[chunks.length - 1],
  );
  assert.ok(
    lastChunkIndex < responseIndex,
    "streamed updates must arrive before the prompt response",
  );

  const { code } = await client.closeAndWait();
  assert.equal(code, 0);
});

test("EOF on stdin cleans up the pi child and exits 0", async (t) => {
  const workspace = makeWorkspace(t);
  const exitMarker = join(tmpdir(), `acp-pi-exit-${Date.now()}-${Math.random()}`);
  const child = spawnAcp(workspace, { FAKE_PI_EXIT_MARKER: exitMarker });
  const client = new JsonRpcClient(child);
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(exitMarker, { force: true });
  });

  await client.request(1, "initialize", { protocolVersion: 1 });
  await client.waitFor((m) => m.id === 1);
  await client.request(2, "session/new", { cwd: workspace, mcpServers: [] });
  await client.waitFor((m) => m.id === 2);

  // The fake Pi is now running; closing the ACP client's stdin must clean it up.
  const { code } = await client.closeAndWait();
  assert.equal(code, 0);

  const marker = await waitForFile(exitMarker);
  assert.ok(marker !== null, "the fake Pi child must have been cleaned up");
});

test("session/cancel aborts the turn, keeps the child alive, and the session stays usable", async (t) => {
  const workspace = makeWorkspace(t);
  const child = spawnAcp(workspace, { FAKE_PI_LONG_TURN: "1" });
  const client = new JsonRpcClient(child);
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  await client.request(1, "initialize", { protocolVersion: 1 });
  await client.waitFor((m) => m.id === 1);
  await client.request(2, "session/new", { cwd: workspace, mcpServers: [] });
  await client.waitFor((m) => m.id === 2);

  // First prompt runs until cancelled (the fake tags "LONG" turns as cancelable).
  await client.request(3, "session/prompt", {
    sessionId: "fake-session-1",
    prompt: [{ type: "text", text: "LONG please keep going" }],
  });
  await client.waitFor(
    (m) =>
      m.method === "session/update" &&
      m.params?.update?.sessionUpdate === "agent_message_chunk",
  );

  await client.send({
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId: "fake-session-1" },
  });

  const cancelled = await client.waitFor((m) => m.id === 3);
  assert.deepEqual(cancelled.result, { stopReason: "cancelled" });

  // The same child must still serve a normal prompt afterwards.
  await client.request(4, "session/prompt", {
    sessionId: "fake-session-1",
    prompt: [{ type: "text", text: "hi" }],
  });
  const after = await client.waitFor((m) => m.id === 4);
  assert.deepEqual(after.result, { stopReason: "end_turn" });

  const chunks = client.messages.filter(
    (m) =>
      m.method === "session/update" &&
      m.params?.update?.sessionUpdate === "agent_message_chunk",
  );
  assert.ok(
    chunks.some((m) => m.params.update.content.text.includes("Hello")),
    "the second prompt must stream from the surviving child",
  );

  const { code } = await client.closeAndWait();
  assert.equal(code, 0);
});

test("session/request_permission deny prevents the tool from executing", async (t) => {
  const workspace = makeWorkspace(t);
  const executedMarker = join(tmpdir(), `acp-pi-tool-${Date.now()}-${Math.random()}`);
  const child = spawnAcp(workspace, {
    FAKE_PI_ASK_PERMISSION: "1",
    FAKE_PI_TOOL_EXECUTED: executedMarker,
  });
  const client = new JsonRpcClient(child);
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(executedMarker, { force: true });
  });

  await client.request(1, "initialize", { protocolVersion: 1 });
  await client.waitFor((m) => m.id === 1);
  await client.request(2, "session/new", { cwd: workspace, mcpServers: [] });
  await client.waitFor((m) => m.id === 2);

  await client.request(3, "session/prompt", {
    sessionId: "fake-session-1",
    prompt: [{ type: "text", text: "do the dangerous thing" }],
  });

  const permission = await client.waitFor(
    (m) => m.method === "session/request_permission",
  );
  assert.equal(permission.params.sessionId, "fake-session-1");
  assert.deepEqual(
    permission.params.options.map((o) => o.optionId),
    ["allow", "deny"],
  );

  await client.send({
    jsonrpc: "2.0",
    id: permission.id,
    result: { outcome: { outcome: "selected", optionId: "deny" } },
  });

  const response = await client.waitFor((m) => m.id === 3);
  assert.deepEqual(response.result, { stopReason: "end_turn" });
  assert.equal(
    existsSync(executedMarker),
    false,
    "deny must prevent the tool from executing",
  );

  const chunks = client.messages
    .filter((m) => m.method === "session/update")
    .map((m) => m.params.update.content.text)
    .join("");
  assert.ok(
    chunks.includes("tool denied"),
    "the deny decision must be routed back to pi",
  );

  const { code } = await client.closeAndWait();
  assert.equal(code, 0);
});

test("a pi crash mid-turn fails the pending prompt with an explicit error", async (t) => {
  const workspace = makeWorkspace(t);
  const child = spawnAcp(workspace, { FAKE_PI_CRASH: "1" });
  const client = new JsonRpcClient(child);
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  await client.request(1, "initialize", { protocolVersion: 1 });
  await client.waitFor((m) => m.id === 1);
  await client.request(2, "session/new", { cwd: workspace, mcpServers: [] });
  await client.waitFor((m) => m.id === 2);

  await client.request(3, "session/prompt", {
    sessionId: "fake-session-1",
    prompt: [{ type: "text", text: "crash now" }],
  });

  const response = await client.waitFor((m) => m.id === 3);
  assert.equal(response.result, undefined);
  assert.ok(response.error, "the pending prompt must fail with an error");
  assert.match(response.error.data?.details ?? "", /exited/);

  await client.closeAndWait();
});

test("session/set_model switches pi to the requested model", async (t) => {
  const workspace = makeWorkspace(t);
  const modelFile = join(tmpdir(), `acp-pi-model-${Date.now()}-${Math.random()}`);
  const child = spawnAcp(workspace, { FAKE_PI_SET_MODEL_FILE: modelFile });
  const client = new JsonRpcClient(child);
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(modelFile, { force: true });
  });

  await client.request(1, "initialize", { protocolVersion: 1 });
  await client.waitFor((m) => m.id === 1);
  await client.request(2, "session/new", { cwd: workspace, mcpServers: [] });
  await client.waitFor((m) => m.id === 2);

  await client.request(3, "session/set_model", {
    sessionId: "fake-session-1",
    modelId: "anthropic/claude-sonnet-4",
  });
  const response = await client.waitFor((m) => m.id === 3);

  assert.deepEqual(response.result, {});
  assert.equal(
    await waitForFile(modelFile),
    "anthropic/claude-sonnet-4\n",
  );

  const { code } = await client.closeAndWait();
  assert.equal(code, 0);
});

test("session/set_model rejects an unknown model with invalid params", async (t) => {
  const workspace = makeWorkspace(t);
  const modelFile = join(tmpdir(), `acp-pi-model-${Date.now()}-${Math.random()}`);
  const child = spawnAcp(workspace, {
    FAKE_PI_REJECT_MODEL: "1",
    FAKE_PI_SET_MODEL_FILE: modelFile,
  });
  const client = new JsonRpcClient(child);
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(modelFile, { force: true });
  });

  await client.request(1, "initialize", { protocolVersion: 1 });
  await client.waitFor((m) => m.id === 1);
  await client.request(2, "session/new", { cwd: workspace, mcpServers: [] });
  await client.waitFor((m) => m.id === 2);

  await client.request(3, "session/set_model", {
    sessionId: "fake-session-1",
    modelId: "anthropic/does-not-exist",
  });
  const response = await client.waitFor((m) => m.id === 3);

  assert.equal(response.result, undefined);
  assert.equal(response.error.code, -32602);
  assert.equal(response.error.message, "Invalid params");
  assert.equal(response.error.data.modelId, "anthropic/does-not-exist");
  assert.equal(
    existsSync(modelFile),
    false,
    "a rejected model must never be applied",
  );

  const { code } = await client.closeAndWait();
  assert.equal(code, 0);
});

test("session/set_model rejects a malformed model id", async (t) => {
  const workspace = makeWorkspace(t);
  const child = spawnAcp(workspace);
  const client = new JsonRpcClient(child);
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  await client.request(1, "initialize", { protocolVersion: 1 });
  await client.waitFor((m) => m.id === 1);
  await client.request(2, "session/new", { cwd: workspace, mcpServers: [] });
  await client.waitFor((m) => m.id === 2);

  await client.request(3, "session/set_model", {
    sessionId: "fake-session-1",
    modelId: "no-slash",
  });
  const response = await client.waitFor((m) => m.id === 3);

  assert.equal(response.result, undefined);
  assert.equal(response.error.code, -32602);
  assert.equal(
    response.error.data.modelId,
    'must be "<provider>/<model-id>"',
  );

  const { code } = await client.closeAndWait();
  assert.equal(code, 0);
});

test("ACP_PI_DEBUG traces methods, params, exceptions and unknown methods", async (t) => {
  const workspace = makeWorkspace(t);
  const child = spawnAcp(workspace, { ACP_PI_DEBUG: "1" });
  const client = new JsonRpcClient(child);
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  await client.request(1, "initialize", { protocolVersion: 1 });
  await client.waitFor((m) => m.id === 1);
  await client.request(2, "session/new", { cwd: workspace, mcpServers: [] });
  await client.waitFor((m) => m.id === 2);

  // A content block the bridge cannot map must fail AND be traced with its
  // params and stack — the exact clue needed for a data-less -32603.
  await client.request(3, "session/prompt", {
    sessionId: "fake-session-1",
    prompt: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
  });
  const failed = await client.waitFor((m) => m.id === 3);
  assert.equal(failed.error.code, -32603);

  // An unknown method must be named in the trace as well.
  await client.request(4, "session/load", { sessionId: "fake-session-1" });
  const unknown = await client.waitFor((m) => m.id === 4);
  assert.equal(unknown.error.code, -32601);

  const { code } = await client.closeAndWait();
  assert.equal(code, 0);

  const stderr = child.stderrText();
  assert.match(stderr, /acp-pi: debug: method initialize/);
  assert.match(stderr, /acp-pi: debug: method session\/new/);
  assert.match(stderr, /acp-pi: debug: params session\/new/);
  assert.match(stderr, /acp-pi: debug: method session\/prompt/);
  assert.match(stderr, /acp-pi: debug: params session\/prompt.*image/);
  assert.match(
    stderr,
    /acp-pi: debug: error in session\/prompt: unsupported prompt content block type: image/,
  );
  assert.match(stderr, /acp-pi: debug: method session\/load/);
  assert.match(stderr, /acp-pi: debug: unknown method session\/load/);
});

test("without ACP_PI_DEBUG the bridge emits no debug lines", async (t) => {
  const workspace = makeWorkspace(t);
  const child = spawnAcp(workspace);
  const client = new JsonRpcClient(child);
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  await client.request(1, "initialize", { protocolVersion: 1 });
  await client.waitFor((m) => m.id === 1);
  await client.request(2, "session/new", { cwd: workspace, mcpServers: [] });
  await client.waitFor((m) => m.id === 2);
  await client.request(3, "session/set_model", {
    sessionId: "fake-session-1",
    modelId: "fake/fake-model",
  });
  await client.waitFor((m) => m.id === 3);

  const { code } = await client.closeAndWait();
  assert.equal(code, 0);

  assert.doesNotMatch(child.stderrText(), /acp-pi: debug:/);
});

test("a failed prompt carries pi's own message to the client", async (t) => {
  // Regression: pi reports usable failures ("No API key found for the selected
  // model."). Converting them into a bare internal error left the client with
  // nothing to show, which is how a missing credential looked like a bridge bug.
  const workspace = makeWorkspace(t);
  const child = spawnAcp(workspace, {
    FAKE_PI_REJECT_PROMPT: "No API key found for the selected model.",
  });
  const client = new JsonRpcClient(child);
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  await client.request(1, "initialize", { protocolVersion: 1 });
  await client.waitFor((m) => m.id === 1);
  await client.request(2, "session/new", { cwd: workspace, mcpServers: [] });
  await client.waitFor((m) => m.id === 2);

  await client.request(3, "session/prompt", {
    sessionId: "fake-session-1",
    prompt: [{ type: "text", text: "Hola" }],
  });
  const response = await client.waitFor((m) => m.id === 3);

  assert.ok(response.error, "a rejected prompt must answer with an error");
  assert.match(response.error.message, /No API key found for the selected model/);
  assert.match(JSON.stringify(response.error.data ?? {}), /No API key/);

  // A failed turn must not wedge the session: the next prompt runs normally.
  await client.request(4, "session/prompt", {
    sessionId: "fake-session-1",
    prompt: [{ type: "text", text: "again" }],
  });
  const second = await client.waitFor((m) => m.id === 4);
  assert.equal(second.result.stopReason, "end_turn");

  const { code } = await client.closeAndWait();
  assert.equal(code, 0);
});

test("a failure while opening a session carries pi's message too", async (t) => {
  // Every protocol path, not just the prompt: a client that cannot see why the
  // session failed will report a generic error and hide a fixable cause.
  const workspace = makeWorkspace(t);
  const child = spawnAcp(workspace, {
    FAKE_PI_FAIL_STATE: "Credential expired, run pi login again.",
  });
  const client = new JsonRpcClient(child);
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  await client.request(1, "initialize", { protocolVersion: 1 });
  await client.waitFor((m) => m.id === 1);
  await client.request(2, "session/new", { cwd: workspace, mcpServers: [] });
  const response = await client.waitFor((m) => m.id === 2);

  assert.ok(response.error, "the failed handshake must answer with an error");
  assert.match(response.error.message, /Credential expired/);

  child.kill("SIGKILL");
});
