import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import {
  PROTOCOL_VERSION,
  RequestError,
} from "@zed-industries/agent-client-protocol";
import { PiRpc, PiRpcError } from "./pi-rpc.mjs";

/** True when `target` is `root` itself or a directory inside it. */
function isWithin(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Flatten ACP prompt content blocks into the plain-text `message` that Pi's
 * `prompt` command accepts. Text blocks pass through; `resource_link` blocks are
 * included as their URI so the reference is not silently dropped. Anything else
 * (image/audio/resource) is rejected explicitly instead of approximated.
 */
function promptToText(prompt) {
  const parts = [];
  for (const block of prompt) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "resource_link") {
      parts.push(block.uri);
    } else {
      throw new PiRpcError(
        `unsupported prompt content block type: ${block.type}`,
        { code: "UNSUPPORTED_CONTENT" },
      );
    }
  }
  return parts.join("\n");
}

/**
 * The agent-side ACP handler. It holds no agent state: one Pi child per session
 * and a pure translation between ACP JSON-RPC and Pi's JSONL RPC.
 */
export class AcpAgent {
  #conn = null;
  #workspace;
  #piCommand;
  #turnTimeoutMs;
  #commandTimeoutMs;
  #session = null;
  #creatingSession = false;

  constructor({ workspace, piCommand, turnTimeoutMs, commandTimeoutMs }) {
    this.#workspace = workspace;
    this.#piCommand = piCommand;
    this.#turnTimeoutMs = turnTimeoutMs;
    this.#commandTimeoutMs = commandTimeoutMs;
  }

  /** Set by the entry point before any request can arrive. */
  attachConnection(conn) {
    this.#conn = conn;
  }

  async initialize(params) {
    if (params.protocolVersion !== PROTOCOL_VERSION) {
      throw RequestError.invalidParams({
        message: `unsupported protocol version ${params.protocolVersion}`,
        supportedProtocolVersion: PROTOCOL_VERSION,
      });
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {},
    };
  }

  async newSession(params) {
    if (this.#session) {
      throw new PiRpcError(
        "this acp-pi process supports a single session",
        { code: "SINGLE_SESSION" },
      );
    }
    // The SDK dispatches requests without awaiting them, so guard against two
    // concurrent session/new calls racing to spawn a child.
    if (this.#creatingSession) {
      throw new PiRpcError("a session is already being created", {
        code: "SESSION_CREATING",
      });
    }
    this.#creatingSession = true;
    try {
      return await this.#createSession(params);
    } finally {
      this.#creatingSession = false;
    }
  }

  async #createSession(params) {
    const cwd = this.#resolveSessionCwd(params.cwd);

    const rpc = new PiRpc({
      command: this.#piCommand,
      cwd,
      turnTimeoutMs: this.#turnTimeoutMs,
      commandTimeoutMs: this.#commandTimeoutMs,
    });
    await rpc.start();

    let state;
    try {
      // Pi RPC has no "ready" event; a successful get_state response proves the
      // child is up and also hands back Pi's own session id.
      state = await rpc.sendCommand({ type: "get_state" });
    } catch (err) {
      await rpc.stop({ graceMs: 0 });
      throw err;
    }
    if (!state || state.success === false) {
      await rpc.stop({ graceMs: 0 });
      throw new PiRpcError(state?.error || "pi did not report its state", {
        code: "NOT_READY",
      });
    }

    const sessionId = state.data?.sessionId ?? randomUUID();
    this.#session = { id: sessionId, rpc, busy: false };
    return { sessionId };
  }

  async prompt(params) {
    const session = this.#requireSession(params.sessionId);
    if (session.busy) {
      throw new PiRpcError(
        "a prompt is already in progress for this session",
        { code: "BUSY" },
      );
    }
    const text = promptToText(params.prompt);

    session.busy = true;
    const off = session.rpc.onEvent((record) =>
      this.#handleEvent(session.id, record),
    );
    const settled = session.rpc.waitForSettled(this.#turnTimeoutMs);
    try {
      const response = await session.rpc.sendCommand({
        type: "prompt",
        message: text,
      });
      if (!response || response.success === false) {
        throw new PiRpcError(response?.error || "pi rejected the prompt", {
          code: "PROMPT_REJECTED",
        });
      }
      if (response.data?.disposition === "handled") {
        // An extension consumed the prompt: no run starts, so agent_settled will
        // never arrive. Resolve immediately instead of waiting for a timeout.
        settled.cancel();
        return { stopReason: "end_turn" };
      }
      await settled.promise;
      return { stopReason: "end_turn" };
    } finally {
      settled.cancel();
      off();
      session.busy = false;
    }
  }

  async cancel() {
    // TODO(T3): implement session/cancel. The Pi child must stay alive and usable
    // for the next prompt, so never kill the child here.
  }

  async shutdown() {
    if (this.#session?.rpc) {
      await this.#session.rpc.stop();
    }
  }

  #resolveSessionCwd(requestedCwd) {
    if (!requestedCwd || !isAbsolute(requestedCwd)) {
      throw RequestError.invalidParams({
        cwd: "must be an absolute path",
      });
    }
    if (!isWithin(this.#workspace, requestedCwd)) {
      throw RequestError.invalidParams({
        cwd: `must be inside the workspace ${this.#workspace}`,
      });
    }
    return requestedCwd;
  }

  #requireSession(sessionId) {
    if (!this.#session) {
      throw new PiRpcError("no session", { code: "NO_SESSION" });
    }
    if (this.#session.id !== sessionId) {
      throw new PiRpcError(`unknown session ${sessionId}`, {
        code: "UNKNOWN_SESSION",
      });
    }
    return this.#session;
  }

  #handleEvent(sessionId, record) {
    if (record.type === "message_update") {
      const event = record.assistantMessageEvent;
      if (event && event.type === "text_delta") {
        this.#conn
          .sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: event.delta },
            },
          })
          .catch(() => {});
      }
      // TODO(T3+): map thinking_delta -> agent_thought_chunk, toolcall_* ->
      // tool_call / tool_call_update, and plan entries.
    }
  }
}
