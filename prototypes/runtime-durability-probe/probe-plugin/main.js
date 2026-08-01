const { Plugin } = require("obsidian");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const PROBE = "__llm_cli_runtime_probe__";
const MAGIC = Buffer.from("LLMCLIWAL1\n", "ascii");
const SLOT_BYTES = 256 * 1024;

function decodeFrame(bytes) {
  if (bytes.length !== SLOT_BYTES || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) return null;
  const headerEnd = bytes.indexOf(0x0a, MAGIC.length);
  if (headerEnd < 0) return null;
  const header = JSON.parse(bytes.subarray(MAGIC.length, headerEnd).toString("utf8"));
  const payload = bytes.subarray(headerEnd + 1, headerEnd + 1 + header.length);
  const checksum = createHash("sha256").update(payload).digest("hex");
  if (payload.length !== header.length || checksum !== header.checksum) return null;
  return JSON.parse(payload.toString("utf8"));
}

function scanJournal(app) {
  const basePath = app.vault.adapter.getBasePath?.();
  if (!basePath) return { status: "unsupported_adapter" };
  const runRoot = globalThis.__llmCliRuntimeProbeRunRoot ?? PROBE;
  const frames = [];
  const errors = [];
  for (const slot of [0, 1]) {
    try {
      const frame = decodeFrame(readFileSync(join(basePath, runRoot, ".journal", `slot-${slot}.wal`)));
      if (frame) frames.push(frame);
      else errors.push({ slot, error: "invalid_frame" });
    } catch (error) {
      errors.push({ slot, error: error.code ?? error.message });
    }
  }
  frames.sort((a, b) => b.sequence - a.sequence);
  return { status: frames[0]?.phase ?? "empty", frame: frames[0] ?? null, errors };
}

module.exports = class RuntimeDurabilityProbePlugin extends Plugin {
  async onload() {
    const previous = globalThis.__llmCliRuntimeProbe;
    previous?.dispose?.();

    const state = {
      generation: (previous?.generation ?? 0) + 1,
      loadedAt: Date.now(),
      events: [],
      maxEvents: 2000,
      disposed: false,
      journalOnLoad: scanJournal(this.app),
    };

    const record = (source, kind, file, extra = {}) => {
      const path = file?.path ?? file ?? null;
      if (path && !path.startsWith(PROBE)) return;
      state.events.push({ seq: state.events.length + 1, at: Date.now(), source, kind, path, ...extra });
      if (state.events.length > state.maxEvents) state.events.shift();
    };

    const refs = [
      [this.app.vault, this.app.vault.on("create", (file) => record("vault", "create", file))],
      [this.app.vault, this.app.vault.on("modify", (file) => record("vault", "modify", file))],
      [this.app.vault, this.app.vault.on("rename", (file, oldPath) => record("vault", "rename", file, { oldPath }))],
      [this.app.vault, this.app.vault.on("delete", (file) => record("vault", "delete", file))],
      [this.app.metadataCache, this.app.metadataCache.on("changed", (file) => record("metadataCache", "changed", file))],
      [this.app.metadataCache, this.app.metadataCache.on("deleted", (file, prevCache) => record("metadataCache", "deleted", file, { hadCache: Boolean(prevCache) }))],
      [this.app.metadataCache, this.app.metadataCache.on("resolve", () => record("metadataCache", "resolve", null))],
      [this.app.metadataCache, this.app.metadataCache.on("resolved", () => record("metadataCache", "resolved", null))],
    ];

    const api = {
      get generation() { return state.generation; },
      get loadedAt() { return state.loadedAt; },
      snapshot: () => JSON.parse(JSON.stringify(state)),
      reset: () => { state.events.length = 0; },
      record: (kind, path, extra) => record("harness", kind, path, extra),
      dispose: () => {
        if (state.disposed) return;
        for (const [emitter, ref] of refs) emitter.offref(ref);
        state.disposed = true;
      },
    };

    globalThis.__llmCliRuntimeProbe = api;
    console.info(`[${this.manifest.id}] ready generation=${state.generation}`);
  }

  onunload() {
    globalThis.__llmCliRuntimeProbe?.record("plugin-unload", null);
    globalThis.__llmCliRuntimeProbe?.dispose();
  }
};
