const { Plugin } = require("obsidian");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const HOST = "127.0.0.1";
const PORT = 27124;
const MCP_PATH = "/mcp";
const PROTOCOL_VERSION = "2025-11-25";
const MAX_PROBE_BYTES = 64 * 1024 * 1024;

function utf8Payload(byteCount) {
  const prefix = `BEGIN:${byteCount}:汉字🙂\n`;
  const suffix = `\nEND:${byteCount}:终🙂`;
  const fillBytes = byteCount - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  if (fillBytes < 0) throw new Error("byte_count is smaller than the marker envelope");
  return prefix + "x".repeat(fillBytes) + suffix;
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function toolResult(structuredContent) {
  return {
    content: [{ type: "text", text: "Structured probe result attached." }],
    structuredContent,
    isError: false,
  };
}

class VaultTransportProbe extends Plugin {
  async onload() {
    this.sessionId = crypto.randomUUID();
    this.continuations = new Map();
    const vaultRoot = this.app.vault.adapter.getBasePath();
    this.logPath = path.join(vaultRoot, this.manifest.dir, "probe-observations.jsonl");
    this.server = http.createServer((request, response) => this.handle(request, response));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(PORT, HOST, resolve);
    });
    this.register(() => this.server?.close());
    this.record({ event: "started", node: process.version, electron: process.versions.electron, port: PORT });
  }

  onunload() {
    this.record({ event: "stopped" });
    this.server?.close();
  }

  record(fields) {
    fs.appendFileSync(this.logPath, `${JSON.stringify({ at: new Date().toISOString(), ...fields })}\n`, "utf8");
  }

  reply(response, status, payload, requestId) {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(body.length),
      "cache-control": "no-store",
      "mcp-session-id": this.sessionId,
    });
    response.end(body);
    this.record({ event: "response", request_id: requestId, status, response_bytes: body.length });
  }

  async handle(request, response) {
    if (request.url !== MCP_PATH) {
      this.reply(response, 404, { error: "not_found" }, null);
      return;
    }
    if (request.method === "GET") {
      response.writeHead(405, { allow: "POST, DELETE" });
      response.end();
      return;
    }
    if (request.method === "DELETE") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST, DELETE" });
      response.end();
      return;
    }

    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let message;
    try {
      message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      this.reply(response, 400, { error: "invalid_json" }, null);
      return;
    }

    const requestId = message.id ?? null;
    this.record({ event: "request", request_id: requestId, method: message.method, params: message.params ?? null });

    if (message.method === "initialize") {
      this.reply(response, 200, jsonRpcResult(requestId, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "vault-transport-probe", version: "0.0.1" },
      }), requestId);
      return;
    }
    if (message.method === "notifications/initialized") {
      response.writeHead(202);
      response.end();
      return;
    }
    if (message.method === "tools/list") {
      this.reply(response, 200, jsonRpcResult(requestId, { tools: [
        {
          name: "probe_payload",
          description: "Return a deterministic UTF-8 payload with BEGIN and END markers. Call only when explicitly asked to measure MCP transport behavior.",
          _meta: { "anthropic/maxResultSizeChars": 500000 },
          inputSchema: {
            type: "object",
            properties: {
              byte_count: { type: "integer", minimum: 64, maximum: MAX_PROBE_BYTES },
              delay_ms: { type: "integer", minimum: 0, maximum: 900000, default: 0 },
            },
            required: ["byte_count"],
            additionalProperties: false,
          },
        },
        {
          name: "probe_continuation_issue",
          description: "Issue a synthetic single-use continuation for lifecycle measurement. Call only when explicitly asked.",
          inputSchema: {
            type: "object",
            properties: {
              retained_bytes: { type: "integer", minimum: 1, maximum: 1048576 },
              ttl_ms: { type: "integer", minimum: 1000, maximum: 3600000 },
            },
            required: ["retained_bytes", "ttl_ms"],
            additionalProperties: false,
          },
        },
        {
          name: "probe_continuation_consume",
          description: "Consume one previously issued synthetic continuation and classify active, expired, consumed, or unknown state.",
          inputSchema: {
            type: "object",
            properties: { continuation: { type: "string" } },
            required: ["continuation"],
            additionalProperties: false,
          },
        },
        {
          name: "probe_state",
          description: "Return installed runtime identity and aggregate Vault note-size facts without returning note content.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ] }), requestId);
      return;
    }
    if (message.method === "tools/call") {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      if (name === "probe_payload") {
        const byteCount = Number(args.byte_count);
        const delayMs = Number(args.delay_ms ?? 0);
        if (!Number.isInteger(byteCount) || byteCount < 64 || byteCount > MAX_PROBE_BYTES || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 900000) {
          this.reply(response, 200, jsonRpcResult(requestId, { content: [{ type: "text", text: "invalid probe parameters" }], isError: true }), requestId);
          return;
        }
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        const payload = utf8Payload(byteCount);
        const checksum = crypto.createHash("sha256").update(payload, "utf8").digest("hex");
        this.reply(response, 200, jsonRpcResult(requestId, toolResult({
          requested_bytes: byteCount,
          payload_bytes: Buffer.byteLength(payload),
          sha256: checksum,
          payload,
        })), requestId);
        return;
      }
      if (name === "probe_continuation_issue") {
        const retainedBytes = Number(args.retained_bytes);
        const ttlMs = Number(args.ttl_ms);
        if (!Number.isInteger(retainedBytes) || retainedBytes < 1 || retainedBytes > 1048576 || !Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 3600000) {
          this.reply(response, 200, jsonRpcResult(requestId, { content: [{ type: "text", text: "invalid continuation parameters" }], isError: true }), requestId);
          return;
        }
        const token = `probe:${crypto.randomUUID()}`;
        const issuedAt = Date.now();
        this.continuations.set(token, { issuedAt, expiresAt: issuedAt + ttlMs, retainedBytes, consumed: false });
        this.reply(response, 200, jsonRpcResult(requestId, toolResult({ continuation: token, ttl_ms: ttlMs, retained_bytes: retainedBytes })), requestId);
        return;
      }
      if (name === "probe_continuation_consume") {
        const token = String(args.continuation ?? "");
        const state = this.continuations.get(token);
        if (!state) {
          this.reply(response, 200, jsonRpcResult(requestId, toolResult({ state: "unknown" })), requestId);
          return;
        }
        const elapsedMs = Date.now() - state.issuedAt;
        if (state.consumed) {
          this.reply(response, 200, jsonRpcResult(requestId, toolResult({ state: "consumed", elapsed_ms: elapsedMs })), requestId);
          return;
        }
        if (Date.now() >= state.expiresAt) {
          state.consumed = true;
          this.reply(response, 200, jsonRpcResult(requestId, toolResult({ state: "expired", elapsed_ms: elapsedMs, retained_bytes_released: state.retainedBytes })), requestId);
          return;
        }
        state.consumed = true;
        this.reply(response, 200, jsonRpcResult(requestId, toolResult({ state: "active", elapsed_ms: elapsedMs, retained_bytes_released: state.retainedBytes })), requestId);
        return;
      }
      if (name === "probe_state") {
        const sizes = this.app.vault.getMarkdownFiles().map((file) => file.stat.size).sort((a, b) => a - b);
        this.reply(response, 200, jsonRpcResult(requestId, toolResult({
          prototype: true,
          electron: process.versions.electron,
          node: process.version,
          markdown_notes: sizes.length,
          aggregate_markdown_bytes: sizes.reduce((sum, size) => sum + size, 0),
          max_markdown_bytes: sizes.at(-1) ?? 0,
          p50_markdown_bytes: sizes[Math.floor(sizes.length / 2)] ?? 0,
        })), requestId);
        return;
      }
      this.reply(response, 200, jsonRpcResult(requestId, { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true }), requestId);
      return;
    }
    if (message.method?.startsWith("notifications/")) {
      response.writeHead(202);
      response.end();
      return;
    }
    this.reply(response, 200, { jsonrpc: "2.0", id: requestId, error: { code: -32601, message: "Method not found" } }, requestId);
  }
}

module.exports = VaultTransportProbe;
