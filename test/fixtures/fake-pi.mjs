#!/usr/bin/env node
/**
 * Deterministic fake `pi` for tests. It speaks the strict JSONL RPC contract that
 * acp-pi expects: one JSON object per line, `response` records echo the command
 * `id`, and a `prompt` emits a known event stream ending in `agent_settled`.
 *
 * Controlled through environment variables (inherited from the test runner):
 *   FAKE_PI_SESSION_ID   session id reported by get_state (default "fake-session-1")
 *   FAKE_PI_CWD_FILE     when set, writes process.cwd() here on get_state
 *   FAKE_PI_EXIT_MARKER  when set, writes a line here as the process exits
 */
import { writeFileSync } from "node:fs";

const sessionId = process.env.FAKE_PI_SESSION_ID ?? "fake-session-1";

let exitMarked = false;
function markExit() {
  if (exitMarked) return;
  exitMarked = true;
  if (process.env.FAKE_PI_EXIT_MARKER) {
    try {
      writeFileSync(process.env.FAKE_PI_EXIT_MARKER, "exited\n");
    } catch {
      // Best effort; the test only uses this to observe cleanup.
    }
  }
}

function send(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function handleCommand(command) {
  if (command.type === "get_state") {
    if (process.env.FAKE_PI_CWD_FILE) {
      writeFileSync(process.env.FAKE_PI_CWD_FILE, `${process.cwd()}\n`);
    }
    send({
      id: command.id,
      type: "response",
      command: "get_state",
      success: true,
      data: { sessionId, cwd: process.cwd(), isStreaming: false },
    });
    return;
  }

  if (command.type === "prompt") {
    send({
      id: command.id,
      type: "response",
      command: "prompt",
      success: true,
      data: { disposition: "started" },
    });
    const timestamp = Date.now();
    send({
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: command.message }], timestamp },
    });
    send({
      type: "message_start",
      message: { role: "assistant", content: [], stopReason: "pending", timestamp },
    });
    send({
      type: "message_update",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    });
    send({
      type: "message_update",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello " },
    });
    send({
      type: "message_update",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "world" },
    });
    send({
      type: "message_update",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hello world" },
    });
    send({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Hello world" }], stopReason: "stop", timestamp },
    });
    send({
      type: "turn_end",
      message: { role: "assistant", content: [{ type: "text", text: "Hello world" }], stopReason: "stop", timestamp },
      toolResults: [],
    });
    send({ type: "agent_end", messages: [], willRetry: false });
    send({ type: "agent_settled", aborted: false });
    return;
  }

  // Unknown commands are acknowledged so a bridge never hangs on them.
  send({
    id: command.id,
    type: "response",
    command: command.type ?? "unknown",
    success: true,
    data: {},
  });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let command;
    try {
      command = JSON.parse(line);
    } catch {
      continue;
    }
    handleCommand(command);
  }
});

process.stdin.on("end", () => {
  markExit();
  process.exit(0);
});

process.on("exit", markExit);
