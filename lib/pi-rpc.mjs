import { spawn } from "node:child_process";

/**
 * Error raised by the Pi RPC transport. Every failure the bridge observes on the
 * Pi side (startup, command rejection, invalid JSON, child exit, timeout) is
 * surfaced as one of these so the pending ACP request can fail explicitly instead
 * of hanging.
 */
export class PiRpcError extends Error {
  constructor(message, { cause, code } = {}) {
    super(message, { cause });
    this.name = "PiRpcError";
    this.code = code;
  }
}

/**
 * A long-lived `pi --mode rpc --no-session` child process.
 *
 * Pi speaks strict JSONL over stdio: one JSON object per line, LF-terminated.
 * Commands are written to stdin; `response` records (matched by `id`) and session
 * events are read from stdout. See Pi's `docs/rpc.md` / `docs/rpc-commands.md`.
 */
export class PiRpc {
  #command;
  #cwd;
  #turnTimeoutMs;
  #commandTimeoutMs;
  #child = null;
  #nextId = 1;
  #pending = new Map();
  #eventListeners = new Set();
  #settleWaiters = new Set();
  #exitWaiters = [];
  #exited = null;
  #stderr = "";

  constructor({
    command,
    cwd,
    turnTimeoutMs = 600_000,
    commandTimeoutMs = 10_000,
  }) {
    if (!Array.isArray(command) || command.length === 0) {
      throw new TypeError("PiRpc command must be a non-empty argv array");
    }
    this.#command = command;
    this.#cwd = cwd;
    this.#turnTimeoutMs = turnTimeoutMs;
    this.#commandTimeoutMs = commandTimeoutMs;
  }

  /** Exit info once the child has exited, or `null` while it is still running. */
  get exited() {
    return this.#exited;
  }

  /** Everything the child wrote to stderr so far (diagnostics, not protocol data). */
  get stderr() {
    return this.#stderr;
  }

  /**
   * Spawn the child. Resolves once the process has spawned successfully; rejects
   * if it cannot be spawned (e.g. missing binary).
   */
  start() {
    return new Promise((resolve, reject) => {
      const [bin, ...args] = this.#command;
      let child;
      try {
        child = spawn(bin, args, {
          cwd: this.#cwd,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        reject(
          new PiRpcError(`failed to spawn pi: ${err.message}`, { cause: err }),
        );
        return;
      }
      this.#child = child;

      let settled = false;
      const onError = (err) => {
        if (settled) return;
        settled = true;
        reject(
          new PiRpcError(`failed to start pi: ${err.message}`, { cause: err }),
        );
      };
      child.once("error", onError);
      child.once("spawn", () => {
        if (settled) return;
        settled = true;
        child.removeListener("error", onError);
        resolve();
      });

      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          this.#handleLine(line);
        }
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        this.#stderr += chunk;
      });

      child.on("exit", (code, signal) => this.#handleExit(code, signal));
    });
  }

  /**
   * Send one command object (e.g. `{type:"get_state"}` or
   * `{type:"prompt",message:"..."}`). An `id` is added automatically and the
   * returned promise resolves with the matching `response` record, or rejects on
   * timeout / child exit / write failure.
   */
  sendCommand(command, timeoutMs = this.#commandTimeoutMs) {
    if (this.#exited) {
      return Promise.reject(
        new PiRpcError("pi exited before the command could be sent", {
          code: "EXITED",
        }),
      );
    }
    const id = `cmd-${this.#nextId++}`;
    const record = { ...command, id };
    return new Promise((resolve, reject) => {
      let timer;
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(
            new PiRpcError(
              `timed out waiting for pi response to ${
                record.type ?? "command"
              } after ${timeoutMs}ms`,
              { code: "TIMEOUT" },
            ),
          );
        }, timeoutMs);
      }
      this.#pending.set(id, { resolve, reject, timer });
      this.#writeRecord(record).catch((err) => {
        if (this.#pending.delete(id)) {
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  /**
   * Write one raw protocol record without waiting for a correlated `response`.
   * The extension UI sub-protocol answers `extension_ui_request` dialogs with an
   * `extension_ui_response` record, which never produces a command response.
   */
  writeRecord(record) {
    return this.#writeRecord(record);
  }

  /**
   * Subscribe to session events (everything on stdout that is not a correlated
   * command response). Returns an unsubscribe function.
   */
  onEvent(listener) {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  /**
   * Returns a handle that resolves when the child emits `agent_settled` (the end
   * of a session-level run), or rejects on timeout / child exit / invalid JSON.
   * Subscribe before sending the prompt so a fast completion is not missed.
   */
  waitForSettled(timeoutMs = this.#turnTimeoutMs) {
    const waiter = { resolve: null, reject: null, timer: null };
    const promise = new Promise((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
      if (timeoutMs && timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          this.#settleWaiters.delete(waiter);
          reject(
            new PiRpcError(
              `timed out waiting for agent_settled after ${timeoutMs}ms`,
              { code: "TIMEOUT" },
            ),
          );
        }, timeoutMs);
      }
      this.#settleWaiters.add(waiter);
    });
    return {
      promise,
      cancel: () => {
        // Detach without settling: callers that give up before agent_settled
        // (e.g. a "handled" disposition) must not leave a dangling rejection.
        if (this.#settleWaiters.delete(waiter)) {
          if (waiter.timer) clearTimeout(waiter.timer);
        }
      },
    };
  }

  /** Resolves with `{code, signal}` once the child exits. */
  waitForExit() {
    if (this.#exited) return Promise.resolve(this.#exited);
    return new Promise((resolve) => this.#exitWaiters.push(resolve));
  }

  /**
   * Stop the child. Pi's documented orderly shutdown is "close stdin"; we do that
   * first and only escalate to SIGTERM/SIGKILL if the child does not leave.
   */
  async stop({ graceMs = 1000 } = {}) {
    const child = this.#child;
    if (!child) return;
    if (child.stdin && !child.stdin.destroyed) {
      child.stdin.end();
    }
    const exited = await Promise.race([
      this.waitForExit(),
      new Promise((resolve) => setTimeout(() => resolve(null), graceMs)),
    ]);
    if (!exited && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const exitedAfterTerm = await Promise.race([
        this.waitForExit(),
        new Promise((resolve) => setTimeout(() => resolve(null), graceMs)),
      ]);
      if (!exitedAfterTerm && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  }

  #handleLine(line) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.trim() === "") return;
    let record;
    try {
      record = JSON.parse(line);
    } catch (err) {
      this.#failAll(
        new PiRpcError(`invalid JSON from pi: ${line.slice(0, 200)}`, {
          cause: err,
          code: "INVALID_JSON",
        }),
      );
      return;
    }
    this.#route(record);
  }

  #route(record) {
    if (record && record.type === "response") {
      const key =
        record.id === undefined || record.id === null
          ? null
          : String(record.id);
      if (key !== null && this.#pending.has(key)) {
        const pending = this.#pending.get(key);
        this.#pending.delete(key);
        if (pending.timer) clearTimeout(pending.timer);
        if (record.success === false) {
          pending.reject(
            new PiRpcError(
              record.error || `pi command failed: ${record.command ?? "unknown"}`,
              { code: "COMMAND_FAILED" },
            ),
          );
        } else {
          pending.resolve(record);
        }
        return;
      }
    }
    this.#emit(record);
  }

  #emit(record) {
    for (const listener of [...this.#eventListeners]) {
      try {
        listener(record);
      } catch {
        // A listener bug must not break the protocol reader.
      }
    }
    if (record.type === "agent_settled") {
      for (const waiter of [...this.#settleWaiters]) {
        this.#settleWaiters.delete(waiter);
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve(record);
      }
    }
  }

  #handleExit(code, signal) {
    this.#exited = { code, signal };
    this.#failAll(
      new PiRpcError(`pi exited unexpectedly (code=${code}, signal=${signal})`, {
        code: "EXITED",
      }),
    );
    const waiters = this.#exitWaiters;
    this.#exitWaiters = [];
    for (const resolve of waiters) resolve(this.#exited);
  }

  #failAll(error) {
    for (const [id, pending] of [...this.#pending]) {
      this.#pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    for (const waiter of [...this.#settleWaiters]) {
      this.#settleWaiters.delete(waiter);
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  #writeRecord(record) {
    return new Promise((resolve, reject) => {
      const stdin = this.#child?.stdin;
      if (!stdin || stdin.destroyed || !stdin.writable || this.#exited) {
        reject(
          new PiRpcError("pi child is not running", { code: "EXITED" }),
        );
        return;
      }
      const onError = (err) => {
        cleanup();
        reject(
          new PiRpcError(`failed to write to pi: ${err.message}`, {
            cause: err,
          }),
        );
      };
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        stdin.removeListener("error", onError);
        stdin.removeListener("drain", onDrain);
      };
      const line = `${JSON.stringify(record)}\n`;
      const ok = stdin.write(line);
      if (ok) {
        cleanup();
        resolve();
      } else {
        stdin.once("drain", onDrain);
        stdin.once("error", onError);
      }
    });
  }
}
