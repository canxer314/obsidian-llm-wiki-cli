/**
 * Headless owning-process entrypoint for the process-crash corpus (issue #187).
 *
 * This process boots the production Bridge stack exactly the way the Obsidian
 * plugin host does — ChangeSetService + the real node-fs Change Set
 * host/execution adapter + the Recovery Journal + the managed Bridge runtime
 * listening on loopback — but without importing the Obsidian plugin module
 * (`main.ts` is the only Obsidian-dependent module and is not runnable
 * headless). A supervisor (the crash-corpus runner) spawns this entrypoint
 * against a dedicated scenario root and drives it through the MCP surface.
 *
 * Control surface (test-only, via environment):
 *
 * - `CORPUS_ROOT`: absolute scenario (Vault) root.
 * - `CORPUS_VAULT_ID`: deterministic Vault identity persisted across restarts.
 * - `CORPUS_PORT`: loopback port persisted across restarts.
 * - `CORPUS_CONTROL_DIR`: directory the process reports lifecycle state into:
 *   `ready.json` (Bridge listening and Change Set service open),
 *   `parked.json` (the armed crash point was reached; the process parks there),
 *   `failed.json` (startup failed), and `events.jsonl` (monotonic child log).
 * - `CORPUS_CRASH_POINT`: optional named crash point to arm. When reached the
 *   process writes `parked.json` and then blocks forever so the supervisor can
 *   confirm the on-disk boundary and terminate the real process. No-op when
 *   omitted.
 */

import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat as fsStat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { TextDecoder } from "node:util";

import { BRIDGE_STATE_DIRECTORY_NAME } from "../change-set.js";
import { createBridgeInstance } from "../bridge-instance.js";
import { contentVersion } from "../content-version.js";
import { createFileSystemChangeSetDataSource } from "../file-system-change-set-data-source.js";
import {
  createChangeSetSemanticEvidenceTracker,
  createFileSystemChangeSetExecutionAdapter,
  createNodeFileSystemChangeSetHost,
} from "../file-system-change-set-execution.js";
import { ManagedVaultBridgeRuntime } from "../managed-vault-runtime.js";
import {
  enumerateDecodedReferenceTargets,
  type CanonicalReferenceCandidate,
} from "../obsidian-search-data-source.js";
import type {
  HostReferenceEvidence,
  HostLocation,
  SearchSnapshotDataSource,
  SearchSnapshotSemanticEvidence,
} from "../search-snapshot.js";

export const CORPUS_ENV_KEYS = [
  "CORPUS_ROOT",
  "CORPUS_VAULT_ID",
  "CORPUS_PORT",
  "CORPUS_CONTROL_DIR",
] as const;

interface CorpusProcessEnvironment {
  CORPUS_ROOT: string;
  CORPUS_VAULT_ID: string;
  CORPUS_PORT: string;
  CORPUS_CONTROL_DIR: string;
  CORPUS_CRASH_POINT?: string;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Atomic control-file publication so a supervising process polling the file
  // never observes a partial write.
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, "utf8");
  await rename(temporary, path);
}

async function appendEvent(
  controlDir: string,
  event: Record<string, unknown>,
): Promise<void> {
  const path = join(controlDir, "events.jsonl");
  await mkdir(controlDir, { recursive: true });
  await writeFile(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
}

async function readOptionalJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readAsArrayBuffer(path: string): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(await readFile(path));
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function pathKind(path: string): Promise<"file" | "folder" | null> {
  try {
    const value = await fsStat(path);
    if (value.isDirectory()) return "folder";
    if (value.isFile()) return "file";
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function walkMarkdownFiles(root: string): Promise<string[]> {
  const base = await realpath(root);
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === BRIDGE_STATE_DIRECTORY_NAME) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const rel = relative(base, absolute);
        if (rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(`${sep}..`)) {
          found.push(rel.split(sep).join("/"));
        }
      }
    }
  };
  await walk(base);
  return found;
}

const corpusTextDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Candidate notes used to resolve a corpus wikilink exactly like the host does. */
function corpusMarkdownCandidates(paths: readonly string[]): CanonicalReferenceCandidate[] {
  return paths.map((path) => {
    const filename = path.slice(path.lastIndexOf("/") + 1);
    return {
      path,
      basename: filename.endsWith(".md") ? filename.slice(0, -3) : filename,
      aliases: [],
    };
  });
}

function corpusLocationAt(content: string, index: number): HostLocation {
  let line = 0;
  let lineStart = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (content.charCodeAt(cursor) === 10 /* \n */) {
      line += 1;
      lineStart = cursor + 1;
    }
  }
  return { line, col: index - lineStart, offset: index };
}

interface ParsedCorpusReference {
  profile: "wikilink" | "embed";
  original: string;
  /** Reference target before any alias/fragment, mirroring the registered grammar. */
  linkPath: string;
  start: number;
  end: number;
}

/**
 * Scan decoded Markdown content for the registered wikilink/embed grammar. The
 * corpus fixtures author every reference as a plain `[[Note]]` / `![[Note]]`, so
 * a single parse covers the derived-rewrite closure without depending on any
 * Obsidian metadata cache.
 */
function scanCorpusReferences(content: string): ParsedCorpusReference[] {
  const found: ParsedCorpusReference[] = [];
  let from = 0;
  while (true) {
    const open = content.indexOf("[[", from);
    if (open < 0) break;
    const embedded = content.charCodeAt(open - 1) === 0x21; // '!'
    const close = content.indexOf("]]", open + 2);
    if (close < 0) break;
    const original = content.slice(open, close + 2);
    const prefixLength = embedded ? 3 : 2;
    const inner = original.slice(prefixLength, -2);
    const fragment = inner.indexOf("#");
    const alias = inner.indexOf("|");
    const separator =
      fragment < 0 ? alias : alias < 0 ? fragment : Math.min(fragment, alias);
    const linkPath = separator < 0 ? inner : inner.slice(0, separator);
    if (linkPath.length > 0) {
      found.push({
        profile: embedded ? "embed" : "wikilink",
        original,
        linkPath,
        start: open,
        end: close + 2,
      });
    }
    from = close + 2;
  }
  return found;
}

/**
 * File-system Search Snapshot data source for a headless owning process. There
 * is no Obsidian metadata cache to observe, so "semantic evidence" for a note
 * is its exact on-disk bytes plus the wikilink reference graph parsed from those
 * bytes. The successor snapshot converges as soon as it reflects the file and
 * the reference graph resolves, which keeps the production success-barrier code
 * path (content-version targets, the resolved/unresolved link graph, and the
 * quiet-window rebuild) intact while running without Obsidian (issue #189).
 */
function createCorpusSearchSnapshotDataSource(root: string): SearchSnapshotDataSource {
  const readBytes = async (path: string): Promise<Uint8Array> =>
    new Uint8Array(await readFile(join(root, ...path.split("/"))));
  const dataSource: SearchSnapshotDataSource = {
    async listMarkdownPaths() {
      return walkMarkdownFiles(root);
    },
    async readBinary(path) {
      return readAsArrayBuffer(join(root, ...path.split("/")));
    },
    async semanticEvidence(path): Promise<SearchSnapshotSemanticEvidence> {
      const bytes = await readBytes(path);
      const decoded = corpusTextDecoder.decode(bytes);
      // Mirror the snapshot builder: offsets are relative to the BOM-stripped
      // host content even when a fixture carries a UTF-8 BOM.
      const content = decoded.startsWith("﻿") ? decoded.slice(1) : decoded;
      const candidates = corpusMarkdownCandidates(await dataSource.listMarkdownPaths());
      const references: HostReferenceEvidence[] = [];
      const resolvedLinks: Record<string, number> = {};
      const unresolvedLinks: Record<string, number> = {};
      for (const parsed of scanCorpusReferences(content)) {
        let resolvedPath: string | null = null;
        try {
          const targets = enumerateDecodedReferenceTargets(
            parsed.linkPath,
            candidates,
            path,
          );
          const only = targets[0];
          if (targets.length === 1 && only !== undefined) resolvedPath = only;
        } catch {
          // A non-canonical target is unresolved in the corpus graph.
          resolvedPath = null;
        }
        if (resolvedPath === null) {
          unresolvedLinks[parsed.linkPath] = (unresolvedLinks[parsed.linkPath] ?? 0) + 1;
        } else {
          resolvedLinks[resolvedPath] = (resolvedLinks[resolvedPath] ?? 0) + 1;
        }
        references.push({
          profile: parsed.profile,
          target: parsed.linkPath,
          resolvedPath,
          original: parsed.original,
          position: {
            start: corpusLocationAt(content, parsed.start),
            end: corpusLocationAt(content, parsed.end),
          },
        });
      }
      return {
        contentVersion: contentVersion(bytes),
        frontmatter: {},
        tags: [],
        headings: [],
        references,
        resolvedLinks,
        unresolvedLinks,
      };
    },
  };
  return dataSource;
}

/** Minimal node-fs vault adapter matching the production data-source seam. */
function createCorpusFileSystemVaultAdapter(root: string) {
  const absolute = (path: string): string => join(root, ...path.split("/"));
  return {
    exists: async (path: string): Promise<boolean> => pathExists(absolute(path)),
    readBinary: async (path: string): Promise<ArrayBuffer> =>
      readAsArrayBuffer(absolute(path)),
    stat: async (
      path: string,
    ): Promise<{ type: "file" | "folder" } | null> => {
      const kind = await pathKind(absolute(path));
      return kind === null ? null : { type: kind };
    },
  };
}

function parseEnvironment(): CorpusProcessEnvironment {
  const record = process.env as Record<string, string | undefined>;
  const missing = CORPUS_ENV_KEYS.filter((key) => record[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`Corpus owning process is missing environment: ${missing.join(", ")}`);
  }
  return {
    CORPUS_ROOT: record.CORPUS_ROOT!,
    CORPUS_VAULT_ID: record.CORPUS_VAULT_ID!,
    CORPUS_PORT: record.CORPUS_PORT!,
    CORPUS_CONTROL_DIR: record.CORPUS_CONTROL_DIR!,
    ...(record.CORPUS_CRASH_POINT === undefined
      ? {}
      : { CORPUS_CRASH_POINT: record.CORPUS_CRASH_POINT }),
  };
}

export async function bootHeadlessOwningProcess(): Promise<void> {
  const env = parseEnvironment();
  const controlDir = env.CORPUS_CONTROL_DIR;
  await mkdir(controlDir, { recursive: true });
  const report = async (file: string, value: unknown): Promise<void> => {
    await writeJson(join(controlDir, file), value);
  };

  const root = env.CORPUS_ROOT;
  const stateDirectory = join(root, BRIDGE_STATE_DIRECTORY_NAME);
  const pluginDataPath = join(stateDirectory, "plugin-data.json");
  const recoveryStatePath = join(stateDirectory, "bridge-state.json");
  const recoveryJournalPath = join(stateDirectory, "recovery-journal.bin");
  const vaultId = env.CORPUS_VAULT_ID;
  const port = Number(env.CORPUS_PORT);
  const armedCrashPoint =
    env.CORPUS_CRASH_POINT === undefined || env.CORPUS_CRASH_POINT === ""
      ? undefined
      : env.CORPUS_CRASH_POINT;

  // Corpus reference graph: the fixtures never author an inbound link to a
  // trashed path, so every path is unreferenced before and after the Change
  // Set. This satisfies the targeted reference probe the managed-trash success
  // barrier polls without requiring Obsidian's resolved-link cache.
  const referenced = async (): Promise<boolean> => false;
  // There is no Obsidian metadata cache in the headless owning process, so the
  // targeted cache-visibility probe observes the raw public path state the
  // cache is a view over: a trashed Markdown note stops being cache-visible
  // once its public path is removed, and a restored note becomes cache-visible
  // again when its public bytes return (issue #191 AC4).
  const cacheVisible = async (path: string): Promise<boolean> =>
    pathExists(join(root, ...path.split("/")));

  // The crash seam is always present so every reached crash point is recorded
  // in the monotonic child event log; when an armed crash point is reached the
  // process writes `parked.json` and then parks until the supervisor terminates
  // it. Unarmed, every hook is a no-op beyond the event-log line.
  const crashInjector = async (point: string): Promise<void> => {
    await appendEvent(controlDir, { event: "crash-point", point });
    if (point !== armedCrashPoint) return;
    await report("parked.json", { point });
    await appendEvent(controlDir, { event: "parked", point });
    await new Promise<void>(() => undefined);
  };

  // Keep the event loop alive across startup recovery. Startup recovery can
  // execute a queued/prepared Change Set whose successor-snapshot quiet window
  // is an unref'd timer; with no HTTP listener bound yet (the Bridge only
  // starts listening after recovery) nothing else would keep the process alive
  // and it would exit before recovery completes. The loopback listener takes
  // over once `ready.json` is written.
  const keepAlive = setInterval(() => undefined, 30_000);

  try {
    await appendEvent(controlDir, { event: "boot", vaultId, port, armedCrashPoint });
    let runtime!: ManagedVaultBridgeRuntime;
    const searchDataSource = createCorpusSearchSnapshotDataSource(root);
    const changeSetDataSource = createFileSystemChangeSetDataSource(
      root,
      createCorpusFileSystemVaultAdapter(root),
    );
    const semanticTracker = createChangeSetSemanticEvidenceTracker({
      publishSuccessorSearchSnapshot: async () => {
        await runtime.publishSuccessorSearchSnapshot();
      },
      probes: {
        cacheVisible,
        referenced,
      },
    });
    const host = await createNodeFileSystemChangeSetHost({
      basePath: root,
      stateDirectory,
      crashInjector,
      referenced,
      // No Obsidian metadata-cache watcher runs in the headless owning process,
      // so the node-fs host reports the public renames it performs; the Change
      // Set semantic evidence tracker needs that rename event before the move
      // success barrier may converge (issue #189).
      recordEvent: (event) => semanticTracker.record(event),
      beginSemanticEvidence: async (request) => {
        semanticTracker.begin(request);
      },
      awaitSemanticEvidence: async (request) => {
        await semanticTracker.await(request);
      },
      semanticEvidencePublishesSnapshot: true,
      publishSearchSnapshot: async (targets, moveBarrier) => {
        await runtime.publishSuccessorSearchSnapshot(targets, moveBarrier);
      },
    });
    const changeSetExecution = await createFileSystemChangeSetExecutionAdapter({
      journalPath: recoveryJournalPath,
      host,
    });
    runtime = new ManagedVaultBridgeRuntime({
      vault: { name: "Corpus Vault", path: root },
      settings: {
        load: async () => readOptionalJson(pluginDataPath),
        save: async (settings) => {
          await mkdir(stateDirectory, { recursive: true });
          await writeJson(pluginDataPath, settings);
        },
        loadRecovery: async () => readOptionalJson(recoveryStatePath),
        saveRecovery: async (settings) => {
          await mkdir(stateDirectory, { recursive: true });
          const temporaryPath = join(stateDirectory, "bridge-state.next");
          await writeFile(temporaryPath, `${JSON.stringify(settings)}\n`, "utf8");
          await rename(temporaryPath, recoveryStatePath);
        },
      },
      createBridge: createBridgeInstance,
      searchDataSource,
      changeSetDataSource,
      changeSetExecution,
      createVaultId: () => vaultId,
      selectInitialPort: () => port,
      crashInjector,
    });
    await appendEvent(controlDir, { event: "runtime-loading" });
    await runtime.load();
    const boundPort = runtime.bridge?.port ?? port;
    await report("ready.json", { port: boundPort });
    await appendEvent(controlDir, { event: "ready", port: boundPort });
    clearInterval(keepAlive);
    // The loopback listener keeps this process alive until the supervisor
    // terminates it.
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    await appendEvent(controlDir, { event: "failed", message });
    await report("failed.json", { message });
    process.exit(1);
  }
}

// Entrypoint guard: only boot when the crash-corpus runner spawns this module
// as the owning-process child. The runner always sets CORPUS_ROOT, so this
// keeps importing the module inert (e.g. under the vitest transform) while
// letting the esbuild CJS bundle boot immediately as a standalone process.
if (process.env.CORPUS_ROOT !== undefined) {
  void bootHeadlessOwningProcess();
}


