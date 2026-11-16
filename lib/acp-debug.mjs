/**
 * Environment-gated diagnostics for the ACP bridge.
 *
 * The ACP protocol travels on stdout, so it must never be polluted with debug
 * output. When the operator opts in with `ACP_PI_DEBUG` (anything other than
 * the empty string, "0" or "false"), diagnostic lines are written to stderr.
 * Without that variable nothing is emitted.
 */

function isTruthy(value) {
  if (value === undefined) return false;
  if (value === "") return false;
  if (value === "0") return false;
  if (value.toLowerCase() === "false") return false;
  return true;
}

/** True when the operator asked for diagnostics on stderr. */
export function debugEnabled() {
  return isTruthy(process.env.ACP_PI_DEBUG);
}

/** Write one diagnostic line to stderr, only when debug is enabled. */
export function debugLog(line) {
  if (!debugEnabled()) return;
  process.stderr.write(`acp-pi: debug: ${line}\n`);
}

/**
 * Summarize request params for diagnostics without leaking content. Prompt
 * blocks keep only their `type` and a short text/uri snippet; MCP server
 * configs (which can carry env vars and tokens) collapse to a count; other
 * strings are truncated; unknown nested values become placeholders.
 */
function summarizeParams(params) {
  if (params === undefined) return undefined;
  if (params === null) return null;
  if (typeof params !== "object") {
    return typeof params === "string" ? params.slice(0, 200) : params;
  }
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === "prompt") {
      out.prompt = summarizePrompt(value);
    } else if (key === "mcpServers") {
      out.mcpServers = Array.isArray(value) ? `<${value.length} mcp servers>` : value;
    } else if (key === "_meta") {
      out._meta = "<present>";
    } else if (typeof value === "string") {
      out[key] = value.slice(0, 200);
    } else if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = `<array:${value.length}>`;
    } else {
      out[key] = "<object>";
    }
  }
  return out;
}

function summarizePrompt(prompt) {
  if (!Array.isArray(prompt)) {
    if (typeof prompt === "string") return prompt.slice(0, 200);
    return { type: typeof prompt, value: "<non-array>" };
  }
  return prompt.map((block) => {
    if (!block || typeof block !== "object") return block;
    const type = block.type ?? "unknown";
    if (type === "text") {
      return { type, text: String(block.text ?? "").slice(0, 100) };
    }
    if (type === "resource_link") {
      return { type, uri: String(block.uri ?? "").slice(0, 100) };
    }
    return { type };
  });
}

/** Log the params a handler received (shape only, content trimmed). */
export function debugParams(method, params) {
  const summary = summarizeParams(params);
  const suffix =
    summary === undefined ? "" : ` ${JSON.stringify(summary)}`;
  debugLog(`params ${method}${suffix}`);
}

/** Log a handler exception with its stack, the only clue when ACP has no data. */
export function debugException(method, err) {
  if (!debugEnabled()) return;
  const message =
    err && typeof err.message === "string" ? err.message : String(err);
  process.stderr.write(`acp-pi: debug: error in ${method}: ${message}\n`);
  if (err && typeof err.stack === "string") {
    process.stderr.write(`${err.stack}\n`);
  }
}
