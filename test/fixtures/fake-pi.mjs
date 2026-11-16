#!/usr/bin/env node
/**
 * Deterministic fake `pi` for tests. It speaks the strict JSONL RPC contract that
 * acp-pi expects: one JSON object per line, `response` records echo the command
 * `id`, and a `prompt` emits a known event stream ending in `agent_settled`.
 *
 * Controlled through environment variables (inherited from the test runner):
 *   FAKE_PI_SESSION_ID      session id reported by get_state (default "fake-session-1")
 *   FAKE_PI_CWD_FILE        when set, writes process.cwd() here on get_state
 *   FAKE_PI_EXIT_MARKER     when set, writes a line here as the process exits
 *   FAKE_PI_LONG_TURN       when set, a prompt runs until an `abort` command arrives
 *   FAKE_PI_ASK_PERMISSION  when set, a prompt emits a `confirm` extension_ui_request
 *                           and only settles after an `extension_ui_response`
 *   FAKE_PI_TOOL_EXECUTED   when set (with ASK_PERMISSION), written on `confirmed:true`
 *   FAKE_PI_CRASH           when set, a prompt emits one delta then exits with code 1
 *   FAKE_PI_NO_MODELS       when set, get_state reports no model and
 *                            get_available_models returns an empty list
 *   FAKE_PI_REJECT_MODEL    when set, set_model responds success:false
 *   FAKE_PI_REJECT_PROMPT   when set, the first prompt answers success:false
 *                           with this value as pi's error text
 *   FAKE_PI_SET_MODEL_FILE  when set, writes "provider/modelId" here on set_model
 */
import { writeFileSync } from "node:fs";

const sessionId = process.env.FAKE_PI_SESSION_ID ?? "fake-session-1";

/** The currently selected model, mutated by a successful `set_model`. */
let currentModel = { id: "fake-model", name: "Fake Model", provider: "fake" };

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

/** The in-flight run, or null while idle. */
let activePrompt = null;

/** Whether the simulated prompt rejection already happened. */
let rejectedPrompt = false;

function promptStarted(command) {
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
}

function textDelta(delta) {
  send({
    type: "message_update",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
  });
}

function settleRun(aborted) {
  if (!activePrompt || activePrompt.settled) return;
  activePrompt.settled = true;
  send({ type: "agent_settled", aborted });
  activePrompt = null;
}

function finishNormalPrompt() {
  const timestamp = Date.now();
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
}

function handlePrompt(command) {
  // A prompt rejected before any run starts, with pi's own error text. The real
  // child answers exactly this shape when it cannot use the selected model.
  if (process.env.FAKE_PI_REJECT_PROMPT && !rejectedPrompt) {
    rejectedPrompt = true;
    send({
      id: command.id,
      type: "response",
      command: "prompt",
      success: false,
      error: process.env.FAKE_PI_REJECT_PROMPT,
    });
    return;
  }

  if (process.env.FAKE_PI_CRASH) {
    promptStarted(command);
    textDelta("partial");
    // Simulate the child dying mid-turn. The bridge must fail the pending
    // prompt request explicitly instead of hanging.
    setTimeout(() => process.exit(1), 30);
    return;
  }

  promptStarted(command);
  textDelta("Hello ");

  // A message tagged with "LONG" runs until an `abort` arrives; any later
  // prompt on the same child settles normally so a test can prove the session
  // survives cancellation.
  if (process.env.FAKE_PI_LONG_TURN && command.message.includes("LONG")) {
    textDelta("working...");
    activePrompt = { commandId: command.id, settled: false };
    return;
  }

  if (process.env.FAKE_PI_ASK_PERMISSION) {
    activePrompt = { commandId: command.id, settled: false, waitingPermission: true };
    send({
      type: "extension_ui_request",
      id: "perm-1",
      method: "confirm",
      title: "Allow tool?",
      message: "Run bash: rm -rf /tmp/important?",
    });
    return;
  }

  textDelta("world");
  finishNormalPrompt();
}

function handleAbort(command) {
  if (activePrompt && !activePrompt.settled) {
    settleRun(true);
  }
  send({ id: command.id, type: "response", command: "abort", success: true });
}

function handleUiResponse(command) {
  if (!activePrompt?.waitingPermission || activePrompt.settled) return;
  if (command.confirmed === true) {
    if (process.env.FAKE_PI_TOOL_EXECUTED) {
      writeFileSync(process.env.FAKE_PI_TOOL_EXECUTED, "executed\n");
    }
    textDelta("tool executed");
  } else {
    textDelta("tool denied");
  }
  settleRun(false);
}

function handleCommand(command) {
  if (command.type === "get_state") {
    if (process.env.FAKE_PI_CWD_FILE) {
      writeFileSync(process.env.FAKE_PI_CWD_FILE, `${process.cwd()}\n`);
    }
    const data = { sessionId, cwd: process.cwd(), isStreaming: false };
    if (!process.env.FAKE_PI_NO_MODELS) {
      data.model = currentModel;
    }
    send({
      id: command.id,
      type: "response",
      command: "get_state",
      success: true,
      data,
    });
    return;
  }

  if (command.type === "get_available_models") {
    const models = process.env.FAKE_PI_NO_MODELS ? [] : [currentModel];
    send({
      id: command.id,
      type: "response",
      command: "get_available_models",
      success: true,
      data: { models },
    });
    return;
  }

  if (command.type === "set_model") {
    if (process.env.FAKE_PI_REJECT_MODEL) {
      send({
        id: command.id,
        type: "response",
        command: "set_model",
        success: false,
        error: `Model not found: ${command.provider}/${command.modelId}`,
      });
      return;
    }
    currentModel = {
      id: command.modelId,
      name: command.modelId,
      provider: command.provider,
    };
    if (process.env.FAKE_PI_SET_MODEL_FILE) {
      writeFileSync(
        process.env.FAKE_PI_SET_MODEL_FILE,
        `${command.provider}/${command.modelId}\n`,
      );
    }
    send({
      id: command.id,
      type: "response",
      command: "set_model",
      success: true,
      data: currentModel,
    });
    return;
  }

  if (command.type === "abort") {
    handleAbort(command);
    return;
  }

  if (command.type === "extension_ui_response") {
    handleUiResponse(command);
    return;
  }

  if (command.type === "prompt") {
    handlePrompt(command);
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
