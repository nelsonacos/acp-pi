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
