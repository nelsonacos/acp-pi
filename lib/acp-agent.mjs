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
 * Map one Pi model object to the ACP `ModelInfo` shape. Pi's model identity is
 * `provider` + `id` (that is also what `set_model` takes), so the ACP `modelId`
 * carries both to stay unique and reversible; `name` stays the human label.
 */
function toAcpModel(model) {
  const modelId =
    model.provider && model.id
      ? `${model.provider}/${model.id}`
      : String(model.id ?? model.name ?? "unknown");
  return { modelId, name: model.name ?? model.id ?? "unknown" };
}

/**
 * Build the ACP `models` state from Pi's model list and the active model. The
 * current model is re-added when the list somehow omits it so `currentModelId`
 * always names an entry the client can render.
 */
function toAcpModelState(models, current) {
  const availableModels = models.map(toAcpModel);
  const currentModel = toAcpModel(current);
  if (!availableModels.some((model) => model.modelId === currentModel.modelId)) {
    availableModels.push(currentModel);
  }
  return { availableModels, currentModelId: currentModel.modelId };
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
    const models = await this.#readModelState(rpc, state);
    this.#session = { id: sessionId, rpc, busy: false, cancelRequested: false };
    return { sessionId, ...(models ? { models } : {}) };
  }

  /**
   * Read Pi's model catalog and active model for the ACP `session/new` response.
   * The list comes from `get_available_models`; the active model from the
   * already-read `get_state`. When the catalog command is unavailable (or fails)
   * the active model alone is reported, and when Pi reports no active model at
   * all `models` is omitted rather than invented.
   */
  async #readModelState(rpc, state) {
    const active = state?.data?.model;
    let models = [];
    try {
      const response = await rpc.sendCommand({ type: "get_available_models" });
      if (
        response &&
        response.success !== false &&
        Array.isArray(response.data?.models)
      ) {
        models = response.data.models;
      }
    } catch {
      // Older Pi versions without get_available_models: fall back to the
      // single active model reported by get_state.
    }
    if (models.length === 0 && active) {
      models = [active];
    }
    if (!active) return undefined;
    return toAcpModelState(models, active);
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
    session.cancelRequested = false;
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
      const settledRecord = await settled.promise;
      if (session.cancelRequested || settledRecord?.aborted === true) {
        return { stopReason: "cancelled" };
      }
      return { stopReason: "end_turn" };
    } finally {
      settled.cancel();
      off();
      session.busy = false;
    }
  }

  async cancel(params) {
    const session = this.#requireSession(params.sessionId);
    // A cancel with no turn in flight is a no-op: there is nothing to abort and
    // the child must stay alive for the next prompt.
    if (!session.busy) return;
    session.cancelRequested = true;
    // Pi's documented cancellation is the `abort` command, which stops the
    // current operation and reports `agent_settled {aborted:true}` without
    // killing the child process. The in-flight prompt observes that event and
    // resolves with stopReason "cancelled".
    await session.rpc.sendCommand({ type: "abort" }, this.#turnTimeoutMs);
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
      return;
    }
    if (record.type === "extension_ui_request" && record.method) {
      this.#handleExtensionUiRequest(sessionId, record);
    }
  }

  /**
   * Route Pi's extension UI dialogs. Fire-and-forget status/notification records
   * need no answer; dialog methods block Pi until an `extension_ui_response` is
   * written back, so every one of those must be answered or the turn hangs.
   */
  #handleExtensionUiRequest(sessionId, request) {
    if (!["confirm", "select", "input", "editor"].includes(request.method)) {
      return;
    }
    void this.#answerExtensionUiRequest(sessionId, request);
  }

  async #answerExtensionUiRequest(sessionId, request) {
    const session = this.#session;
    if (!session || session.id !== sessionId || !this.#conn) {
      return;
    }

    // ACP has no free-text dialog. Pi dialogs that cannot be mapped faithfully
    // are rejected explicitly (cancelled), never silently approved.
    if (request.method === "input" || request.method === "editor") {
      await session.rpc
        .writeRecord({
          type: "extension_ui_response",
          id: request.id,
          cancelled: true,
        })
        .catch(() => {});
      return;
    }

    const options =
      request.method === "confirm"
        ? [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ]
        : (request.options ?? []).map((option) => ({
            optionId: option,
            name: option,
            kind: "allow_once",
          }));
    if (options.length === 0) {
      await session.rpc
        .writeRecord({
          type: "extension_ui_response",
          id: request.id,
          cancelled: true,
        })
        .catch(() => {});
      return;
    }

    const title = [request.title, request.message].filter(Boolean).join(": ");
    const toolCall = { toolCallId: request.id };
    if (title) toolCall.title = title;

    try {
      // If the child dies while the client is deciding, stop waiting instead of
      // leaving this handler parked on the client forever.
      const exited = session.rpc.waitForExit().then((info) => {
        throw new PiRpcError(
          `pi exited while awaiting permission (code=${info.code}, signal=${info.signal})`,
          { code: "EXITED" },
        );
      });
      const response = await Promise.race([
        this.#conn.requestPermission({ sessionId, toolCall, options }),
        exited,
      ]);
      const reply = this.#extensionUiReply(request.method, response);
      if (reply) {
        await session.rpc.writeRecord({
          type: "extension_ui_response",
          id: request.id,
          ...reply,
        });
      }
    } catch {
      // The client did not answer (or the child died): dismiss Pi's dialog so
      // the turn cannot hang. This is explicit rejection, never approval.
      await session.rpc
        .writeRecord({
          type: "extension_ui_response",
          id: request.id,
          cancelled: true,
        })
        .catch(() => {});
    }
  }

  #extensionUiReply(method, response) {
    if (!response || response.outcome?.outcome === "cancelled") {
      return { cancelled: true };
    }
    const optionId = response.outcome?.optionId;
    if (method === "confirm") {
      return { confirmed: optionId === "allow" };
    }
    if (optionId !== undefined) {
      return { value: optionId };
    }
    return { cancelled: true };
  }
}
