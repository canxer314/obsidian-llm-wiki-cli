import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  composeRegisteredReferenceRewriteCorpusEvidence,
  createBridgeInstance,
  createFileSystemChangeSetDataSource,
  createFileSystemChangeSetExecutionAdapter,
  createNodeFileSystemChangeSetHost,
  EXPECTED_VAULT_ID_HEADER,
  REGISTERED_REFERENCE_REWRITE_CORPUS_ID,
  REGISTERED_REFERENCE_REWRITE_SCENARIO_PLAN,
  registeredReferenceRewriteFixtures,
  runRegisteredReferenceRewriteCorpus,
  SearchSnapshotManager,
  VaultDiscoverService,
  withMoveReferenceProjection,
  type BridgeHealthState,
  type ChangeSetRegistryState,
  type ChangeSetRegistryStore,
  type ChangeSetPreflightDataSource,
  type HostReferenceEvidence,
  type ObsidianSearchAdapter,
  type RegisteredReferenceRewriteArrange,
  type RegisteredReferenceRewriteFixture,
  type RegisteredReferenceRewriteRejectionSession,
  type RegisteredReferenceRewriteSession,
  type SearchSnapshotDataSource,
  type SearchSnapshotSemanticEvidence,
  type VaultReadDataSource,
  type WireToolName,
} from "../src/index.js";

const EXPECTED_VAULT_ID = "vault-registered-reference-corpus";

/** Matches the production Bridge state directory (never indexed or discovered). */
const BRIDGE_STATE_DIRECTORY_NAME = ".llm-wiki";

const liveBridges: Array<ReturnType<typeof createBridgeInstance>> = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(liveBridges.splice(0).map((bridge) => bridge.stop()));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function healthState(): BridgeHealthState {
  return {
    vault: {
      id: EXPECTED_VAULT_ID,
      name: "RegisteredReference",
      path: "D:/Vaults/RegisteredReference",
    },
    readiness: { searchSnapshot: "ready", cache: "ready", index: "ready" },
    recovery: { state: "none" },
    write: { gate: "open", state: "writable", pauseSource: null },
    queue: { currentExecutionId: null, length: 0, headChangeSetId: null },
    lifecycle: {
      startup: "ready",
      upgrade: "not_run",
      migration: "not_run",
      recovery: "not_run",
    },
    effectiveGate: null,
    overall: "healthy",
    reasonCodes: [],
    operatorAction: "none",
  };
}

async function listMarkdown(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const absolute = join(directory, child.name);
      if (child.isDirectory()) {
        if (child.name === BRIDGE_STATE_DIRECTORY_NAME || child.name === ".obsidian") continue;
        await walk(absolute);
      } else if (child.isFile() && child.name.endsWith(".md")) {
        out.push(absolute.slice(root.length + 1).split("\\").join("/"));
      }
    }
  };
  await walk(root);
  return out.sort();
}

function fsRead(root: string) {
  return async (path: string): Promise<Uint8Array | null> => {
    try {
      return new Uint8Array(await readFile(join(root, ...path.split("/"))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
}

async function fsWrite(root: string, path: string, bytes: Uint8Array): Promise<void> {
  const destination = join(root, ...path.split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}

async function fsKind(root: string, path: string): Promise<"directory" | "file" | null> {
  try {
    const value = await stat(join(root, ...path.split("/")));
    return value.isDirectory() ? "directory" : "file";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function hostContentOf(bytes: Uint8Array): { content: string; hasBom: boolean } {
  const decoded = utf8Decoder.decode(bytes);
  const hasBom = decoded.startsWith("\uFEFF");
  return { content: hasBom ? decoded.slice(1) : decoded, hasBom };
}

function hostLocationAt(content: string, index: number): { line: number; col: number; offset: number } {
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

interface ParsedReference {
  profile: "wikilink" | "embed" | "markdown_inline_link" | "markdown_embed";
  original: string;
  /** Obsidian cache `link`: the destination (alias/title stripped), as written. */
  target: string;
  start: number;
  end: number;
}

/**
 * Reproduces the installed host's MetadataCache evidence for the deterministic
 * fixtures: it scans the four registered grammars and reports each reference
 * with Obsidian-style host positions (UTF-16 code-unit offsets in the
 * BOM-stripped text). Everything downstream — Search Snapshot span location,
 * move projection, and Change Set execution — is production code.
 */
function scanRegisteredReferences(content: string): ParsedReference[] {
  const found: ParsedReference[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const wikilinkOpen = content.indexOf("[[", cursor);
    const markdownOpen = content.indexOf("![", cursor);
    const inlineOpen = content.indexOf("[", cursor);
    const opens = [wikilinkOpen, markdownOpen, inlineOpen]
      .filter((index) => index >= 0)
      .sort((left, right) => left - right);
    const next = opens[0];
    if (next === undefined) break;
    if (next === wikilinkOpen) {
      const close = content.indexOf("]]", wikilinkOpen + 2);
      if (close < 0) break;
      const embedded = wikilinkOpen > 0 && content.charCodeAt(wikilinkOpen - 1) === 0x21; // '!'
      const start = embedded ? wikilinkOpen - 1 : wikilinkOpen;
      const original = content.slice(start, close + 2);
      const inner = content.slice(wikilinkOpen + 2, close);
      const separator = inner.indexOf("|");
      const destination = separator < 0 ? inner : inner.slice(0, separator);
      if (destination.length > 0) {
        found.push({
          profile: embedded ? "embed" : "wikilink",
          original,
          target: destination,
          start,
          end: close + 2,
        });
      }
      cursor = close + 2;
      continue;
    }
    // A wikilink/embed open takes priority; otherwise handle markdown links.
    const bracketOpen = next;
    const bracketClose = content.indexOf("]", bracketOpen + 1);
    if (bracketClose < 0 || content[bracketClose + 1] !== "(") {
      cursor = bracketOpen + 1;
      continue;
    }
    const parenClose = content.indexOf(")", bracketClose + 2);
    if (parenClose < 0) break;
    const embedded = content.charCodeAt(bracketOpen) === 0x21; // '!'
    const original = content.slice(bracketOpen, parenClose + 1);
    const body = content.slice(bracketClose + 2, parenClose);
    let destination: string;
    if (body.startsWith("<")) {
      const wrapperEnd = body.indexOf(">", 1);
      if (wrapperEnd < 0) {
        cursor = bracketOpen + 1;
        continue;
      }
      const tail = body.slice(wrapperEnd + 1);
      if (tail !== "" && !/^\s+(?:"[^"]*"|'[^']*'|\([^)]*\))$/u.test(tail)) {
        cursor = bracketOpen + 1;
        continue;
      }
      destination = body.slice(1, wrapperEnd);
    } else {
      const titleMatch = /\s+(?:"[^"]*"|'[^']*'|\([^)]*\))$/u.exec(body);
      destination = titleMatch === null ? body : body.slice(0, titleMatch.index);
      if (destination.length === 0 || destination.includes(" ")) {
        cursor = bracketOpen + 1;
        continue;
      }
    }
    if (destination.length === 0) {
      cursor = bracketOpen + 1;
      continue;
    }
    found.push({
      profile: embedded ? "markdown_embed" : "markdown_inline_link",
      original,
      target: destination,
      start: bracketOpen,
      end: parenClose + 1,
    });
    cursor = parenClose + 1;
  }
  return found;
}

function splitFragment(target: string): { fileLinkpath: string; fragment: string } {
  const block = target.lastIndexOf("#^");
  const separator = block >= 0 ? block : target.indexOf("#");
  return separator < 0
    ? { fileLinkpath: target, fragment: "" }
    : { fileLinkpath: target.slice(0, separator), fragment: target.slice(separator) };
}

interface CandidateFile {
  path: string;
  basename: string;
  aliases: readonly string[];
}

/** Mirrors the registered target enumeration used by the installed host. */
function resolveDecodedTargets(
  decoded: string,
  files: readonly CandidateFile[],
  sourcePath: string,
): string[] {
  const sourceRelative = decoded.startsWith("./") || decoded.startsWith("../");
  if (sourceRelative) {
    const segments = sourcePath.split("/");
    segments.pop();
    const base = segments.join("/");
    const resolved = [base, decoded].filter((part) => part.length > 0).join("/");
    const normalized = normalizePath(resolved);
    if (normalized === null) return [];
    return files
      .filter((file) => file.path === normalized || file.path === `${normalized}.md`)
      .map((file) => file.path);
  }
  const explicitPath = decoded.includes("/");
  const matches = files.filter((file) => {
    if (explicitPath) {
      return (
        file.path === decoded ||
        (file.path.endsWith(".md") && file.path.slice(0, -3) === decoded)
      );
    }
    const name = file.path.slice(file.path.lastIndexOf("/") + 1);
    return name === decoded || file.basename === decoded || file.aliases.includes(decoded);
  });
  return [...new Set(matches.map((file) => file.path))].sort();
}

function normalizePath(path: string): string | null {
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

/**
 * File-system Obsidian-like semantic evidence source for the installed-runtime
 * corpus (issue #178). There is no Obsidian metadata cache to observe, so the
 * semantic evidence for a note is its exact on-disk bytes plus the registered
 * reference graph parsed from those bytes with Obsidian host position
 * semantics. Reference resolution mirrors the installed host: exactly one
 * canonical target or an invalid fragment rejects the note's evidence
 * (fail-closed), so a Vault whose reference graph cannot close never becomes
 * ready.
 */
function createFileSystemReferenceDataSource(root: string): SearchSnapshotDataSource {
  const readBinary = fsRead(root);
  const decoder = utf8Decoder;
  const dataSource: SearchSnapshotDataSource = {
    listMarkdownPaths: async () => listMarkdown(root),
    readBinary,
    async semanticEvidence(path): Promise<SearchSnapshotSemanticEvidence | null> {
      const bytes = await readBinary(path);
      if (bytes === null) return null;
      const { content } = hostContentOf(bytes);
      const candidates = (await listMarkdown(root)).map((candidatePath) => {
        const filename = candidatePath.slice(candidatePath.lastIndexOf("/") + 1);
        return {
          path: candidatePath,
          basename: filename.endsWith(".md") ? filename.slice(0, -3) : filename,
          aliases: [] as readonly string[],
        };
      });
      const references: HostReferenceEvidence[] = [];
      const resolvedLinks: Record<string, number> = {};
      const unresolvedLinks: Record<string, number> = {};
      for (const parsed of scanRegisteredReferences(content)) {
        const { fileLinkpath, fragment } = splitFragment(parsed.target);
        let resolvedPath: string | null = null;
        let decoded: string;
        if (parsed.profile === "wikilink" || parsed.profile === "embed") {
          decoded = fileLinkpath;
        } else {
          try {
            // The host's candidate enumeration fully component-decodes a
            // Markdown destination (a literal `%23` in a filename resolves to a
            // file whose name contains `#`).
            decoded = decodeURIComponent(fileLinkpath);
          } catch {
            unresolvedLinks[parsed.target] = (unresolvedLinks[parsed.target] ?? 0) + 1;
            references.push({
              profile: parsed.profile,
              target: parsed.target,
              resolvedPath: null,
              original: parsed.original,
              position: {
                start: hostLocationAt(content, parsed.start),
                end: hostLocationAt(content, parsed.end),
              },
            });
            continue;
          }
        }
        const targets = decoded === ""
          ? []
          : resolveDecodedTargets(decoded, candidates, path);
        if (targets.length > 1) {
          // Duplicate basename/target ambiguity is fail-closed (spec §8.2).
          throw new Error("Registered reference must have one unique canonical target");
        }
        resolvedPath = targets[0] ?? null;
        if (fragment !== "" && resolvedPath !== null) {
          const targetBytes = await readBinary(resolvedPath);
          const targetContent = targetBytes === null ? "" : hostContentOf(targetBytes).content;
          if (!isValidSubpath(fragment, targetContent)) {
            throw new Error("Registered reference has an invalid reference fragment");
          }
        }
        if (resolvedPath === null) {
          unresolvedLinks[parsed.target] = (unresolvedLinks[parsed.target] ?? 0) + 1;
        } else {
          resolvedLinks[resolvedPath] = (resolvedLinks[resolvedPath] ?? 0) + 1;
        }
        references.push({
          profile: parsed.profile,
          target: parsed.target,
          resolvedPath,
          original: parsed.original,
          position: {
            start: hostLocationAt(content, parsed.start),
            end: hostLocationAt(content, parsed.end),
          },
        });
      }
      return {
        frontmatter: null,
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

/** Validates an Obsidian `#subpath` against a note's headings (block IDs are
 * unregistered in the installed-runtime evidence, spec §8.2). */
function isValidSubpath(fragment: string, content: string): boolean {
  if (fragment.startsWith("#^")) {
    const id = fragment.slice(2);
    return /^[A-Za-z0-9-]+$/u.test(id) && content.includes(`#^${id}`);
  }
  const heading = fragment.slice(1);
  const headings: string[] = [];
  for (const line of content.split("\n")) {
    const match = /^#{1,6}\s+(.+)$/u.exec(line);
    if (match !== null) headings.push(match[1]!.trim());
  }
  return headings.filter((candidate) => candidate === heading).length === 1;
}

const SEED_NOTES: readonly RegisteredReferenceRewriteFixture[] = [
  { path: "Notes/Welcome.md", content: "# Installed Runtime Harness\n" },
  { path: "Notes/Linked.md", content: "# Linked\n\nSee [[Welcome]] for the harness note.\n" },
];

interface ArrangedSession {
  root: string;
  vaultPath: string;
  registryPath: string;
  snapshots: SearchSnapshotManager;
  readBinary: (path: string) => Promise<Uint8Array | null>;
  arrange: RegisteredReferenceRewriteArrange;
  searchSource: SearchSnapshotDataSource;
  seedNotes: readonly RegisteredReferenceRewriteFixture[];
  fixtures: readonly RegisteredReferenceRewriteFixture[];
}

async function writeFixtureFiles(root: string, fixtures: readonly RegisteredReferenceRewriteFixture[]): Promise<void> {
  for (const fixture of fixtures) {
    await fsWrite(root, fixture.path, Buffer.from(fixture.content, "utf8"));
  }
}

async function arrangeSession(fixtures: readonly RegisteredReferenceRewriteFixture[]): Promise<ArrangedSession> {
  const root = await mkdtemp(join(tmpdir(), "registered-reference-rewrite-"));
  const vaultPath = join(root, "vault");
  await mkdir(vaultPath, { recursive: true });
  await writeFixtureFiles(vaultPath, SEED_NOTES);
  await writeFixtureFiles(vaultPath, fixtures);
  cleanups.push(async () => rm(root, { recursive: true, force: true }));

  const readBinary = fsRead(vaultPath);
  const searchSource = createFileSystemReferenceDataSource(vaultPath);
  const snapshots = new SearchSnapshotManager(searchSource);
  const arrange: RegisteredReferenceRewriteArrange = {
    readBinary,
    writeBinary: async (path, bytes) => fsWrite(vaultPath, path, bytes),
    publishSnapshot: async () => {
      await snapshots.rebuild();
    },
  };
  return {
    root,
    vaultPath,
    registryPath: join(root, "change-set-registry.json"),
    snapshots,
    readBinary,
    arrange,
    searchSource,
    seedNotes: SEED_NOTES,
    fixtures,
  };
}

function persistentStore(path: string): ChangeSetRegistryStore & { state: ChangeSetRegistryState | undefined } {
  let cached: ChangeSetRegistryState | undefined;
  return {
    get state() {
      return cached;
    },
    load: async () => {
      try {
        cached = JSON.parse(await readFile(path, "utf8")) as ChangeSetRegistryState;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") cached = undefined;
        else throw error;
      }
      return structuredClone(cached);
    },
    save: async (state) => {
      cached = structuredClone(state);
      await writeFile(path, `${JSON.stringify(cached)}\n`, "utf8");
    },
  };
}

interface BridgeHost {
  bridge: ReturnType<typeof createBridgeInstance>;
  endpoint: URL;
}

async function createRewriteBridge(host: ArrangedSession, expectReady = true): Promise<BridgeHost> {
  if (expectReady) {
    await host.snapshots.rebuild();
    if (host.snapshots.readiness !== "ready") {
      throw new Error("Registered-reference rewrite Search Snapshot did not become ready");
    }
  } else {
    await host.snapshots.rebuild().catch(() => undefined);
  }
  const store = persistentStore(host.registryPath);
  const dataSource: ChangeSetPreflightDataSource = createFileSystemChangeSetDataSource(
    host.vaultPath,
    {
      exists: async (path) => (await fsKind(host.vaultPath, path)) !== null,
      readBinary: async (path) => (await host.readBinary(path)) as ArrayBuffer | Uint8Array,
      stat: async (path) => {
        const kind = await fsKind(host.vaultPath, path);
        return kind === null ? null : { type: kind === "directory" ? "folder" : "file" };
      },
    },
  );
  const projected = withMoveReferenceProjection(dataSource, host.snapshots);
  const stateDirectory = join(host.vaultPath, BRIDGE_STATE_DIRECTORY_NAME);
  const publishSearchSnapshot = async (): Promise<void> => {
    await host.snapshots.rebuild();
  };
  const fsHost = await createNodeFileSystemChangeSetHost({
    basePath: host.vaultPath,
    stateDirectory,
    awaitSemanticEvidence: async () => undefined,
    semanticEvidencePublishesSnapshot: false,
    publishSearchSnapshot,
  });
  const execution = await createFileSystemChangeSetExecutionAdapter({
    journalPath: join(stateDirectory, "recovery-journal.bin"),
    slotCapacity: 16 * 1024,
    host: fsHost,
  });
  const readDataSource: VaultReadDataSource = {
    readBinary: host.readBinary,
    parseFrontmatter: () => null,
    headings: () => null,
  };
  const bridge = createBridgeInstance({
    port: 0,
    health: healthState(),
    readDataSource,
    discoverService: new VaultDiscoverService(host.snapshots),
    searchSnapshotReadiness: () => host.snapshots.readiness,
    changeSets: {
      store,
      dataSource: projected,
      execution,
      vaultId: EXPECTED_VAULT_ID,
    },
  });
  liveBridges.push(bridge);
  await bridge.start();
  return { bridge, endpoint: bridge.endpoint };
}

async function connectClient(endpoint: URL, vaultId: string): Promise<import("@modelcontextprotocol/sdk/client/index.js").Client> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );
  const client = new Client({ name: "registered-reference-rewrite-corpus", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { [EXPECTED_VAULT_ID_HEADER]: vaultId } },
    }),
  );
  return client;
}

type McpToolResult = {
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
  readonly content?: readonly unknown[];
};

function callToolOf(client: { callTool(tool: string, arguments_: Record<string, unknown>): Promise<unknown> }) {
  return async (tool: WireToolName, arguments_: Record<string, unknown>): Promise<McpToolResult> => {
    const result = await client.callTool({ name: tool, arguments: arguments_ });
    return result as McpToolResult;
  };
}

function scenarioManifestSha256(): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        corpusId: REGISTERED_REFERENCE_REWRITE_CORPUS_ID,
        scenarios: [...REGISTERED_REFERENCE_REWRITE_SCENARIO_PLAN],
      }),
      "utf8",
    )
    .digest("hex");
}

function makeSession(
  host: ArrangedSession,
  callTool: (tool: WireToolName, arguments_: Record<string, unknown>) => Promise<McpToolResult>,
  rejectionSessions: readonly RegisteredReferenceRewriteRejectionSession[],
  observer?: { callTool(tool: WireToolName, arguments_: Record<string, unknown>): Promise<McpToolResult> },
): RegisteredReferenceRewriteSession {
  return {
    callTool,
    arrange: host.arrange,
    observer,
    seedNotes: host.seedNotes,
    fixtures: host.fixtures,
    rejectionSessions,
  };
}

const FIXTURES = registeredReferenceRewriteFixtures();

describe("registered-reference rewrite corpus over a real loopback Bridge", () => {
  it("proves destination-only rewrites, exact-byte spans, no-guessing rejections, and observer privacy", async () => {
    const host = await arrangeSession(FIXTURES);
    const bridgeHost = await createRewriteBridge(host, true);
    const client = await connectClient(bridgeHost.endpoint, EXPECTED_VAULT_ID);
    const observerClient = await connectClient(bridgeHost.endpoint, EXPECTED_VAULT_ID);
    const callTool = callToolOf(client);
    const observerCallTool = callToolOf(observerClient);

    // Dedicated rejection sessions: a duplicate basename, an invalid fragment,
    // and a duplicate heading each make the reference evidence fail closed.
    const rejectionSession = async (
      scenario: string,
      files: readonly RegisteredReferenceRewriteFixture[],
      sourcePath: string,
      destinationPath: string,
    ): Promise<RegisteredReferenceRewriteRejectionSession> => {
      const rejectionHost = await arrangeSession([...FIXTURES, ...files]);
      const rejectionBridge = await createRewriteBridge(rejectionHost, false);
      const rejectionClient = await connectClient(rejectionBridge.endpoint, EXPECTED_VAULT_ID);
      return {
        scenario,
        sourcePath,
        destinationPath,
        callTool: callToolOf(rejectionClient),
        arrange: rejectionHost.arrange,
        expectSnapshotUnavailable: true,
      };
    };

    const duplicateBasename = await rejectionSession(
      "reject/duplicate-basename-ambiguous",
      [
        { path: "ReferenceProof/Amb/A/Shared.md", content: "# A Shared\n" },
        { path: "ReferenceProof/Amb/B/Shared.md", content: "# B Shared\n" },
        { path: "ReferenceProof/Amb/AmbRef.md", content: "See [[Shared]].\n" },
      ],
      "ReferenceProof/Amb/A/Shared.md",
      "ReferenceProof/Amb/A/Shared Moved.md",
    );
    const invalidFragment = await rejectionSession(
      "reject/invalid-fragment-closed",
      [
        { path: "ReferenceProof/Fragment/Source.md", content: "# Source\n" },
        { path: "ReferenceProof/Fragment/FragRef.md", content: "See [[Source#Missing]] now.\n" },
      ],
      "ReferenceProof/Fragment/Source.md",
      "ReferenceProof/Fragment/Source Moved.md",
    );
    const duplicateHeading = await rejectionSession(
      "reject/duplicate-heading-closed",
      [
        {
          path: "ReferenceProof/Heading/Head.md",
          content: "# Head\n\n## Duplicated\n\n## Duplicated\n",
        },
        { path: "ReferenceProof/Heading/HeadRef.md", content: "See [[Head#Duplicated]].\n" },
      ],
      "ReferenceProof/Heading/Head.md",
      "ReferenceProof/Heading/Head Moved.md",
    );

    const events: Array<{
      kind: "transport" | "tool" | "assertion" | "cleanup";
      name: string;
      detail: unknown;
    }> = [];
    const assertions: string[] = [];

    try {
      const outcome = await runRegisteredReferenceRewriteCorpus({
        session: makeSession(
          host,
          callTool,
          [duplicateBasename, invalidFragment, duplicateHeading],
          { callTool: observerCallTool },
        ),
        record: (kind, name, detail) => {
          events.push({ kind, name, detail });
        },
        assertion: (name) => assertions.push(name),
      });

      expect(outcome.scenarioManifestSha256).toBe(scenarioManifestSha256());
      expect(outcome.scenarioManifestSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(outcome.seedInventoryDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(outcome.beforeInventory).toEqual(outcome.afterInventory);
      expect(outcome.moves).toHaveLength(4);
      expect(outcome.moves.map((move) => move.profile)).toEqual(
        expect.arrayContaining([
          "wikilink",
          "embed",
          "markdown_inline_link",
          "markdown_embed",
        ]),
      );
      expect(outcome.rawBytes.duplicateEqualSpellingsRewritten).toBe(2);
      expect(outcome.rawBytes.fixtures[0]?.hostModes).toEqual(
        expect.arrayContaining(["bom", "crlf", "cjk", "astral"]),
      );
      expect(outcome.rejections.map(({ scenario }) => scenario)).toEqual(
        expect.arrayContaining([
          "reject/stale-closure",
          "reject/literal-hash-destination",
          "reject/duplicate-basename-ambiguous",
          "reject/invalid-fragment-closed",
          "reject/duplicate-heading-closed",
        ]),
      );
      expect(outcome.rejections.every((entry) => entry.registered)).toBe(true);
      expect(outcome.observer.enabledSecondObserver).toBe(true);
      expect(outcome.observer.discoversIssued).toBeGreaterThan(0);
      expect(outcome.residualCleanup).toEqual({
        recoveryState: "none",
        queueLength: 0,
        currentExecutionId: null,
        writeGate: "open",
      });

      // The deterministic seed Notes are byte-identical after the whole corpus.
      for (const { path, content } of host.seedNotes) {
        const bytes = await host.readBinary(path);
        expect(Buffer.from(bytes ?? new Uint8Array()).toString("utf8")).toBe(content);
      }

      const evidence = composeRegisteredReferenceRewriteCorpusEvidence({
        outcome,
        events,
        assertions,
      });
      expect(evidence.corpusId).toBe(REGISTERED_REFERENCE_REWRITE_CORPUS_ID);
      expect(evidence.verdict).toBe("passed");
      expect(evidence.moves).toHaveLength(4);
      expect(evidence.rejections.length).toBeGreaterThanOrEqual(5);
      expect(evidence.beforeInventory.digest).toBe(evidence.afterInventory.digest);
      expect(evidence.assertions.length).toBeGreaterThan(20);
      expect(events.filter(({ kind }) => kind === "tool").length).toBeGreaterThan(10);
    } finally {
      await observerClient.close();
      await client.close();
    }
  }, 120_000);

  it("derives the same deterministic corpus identity across fresh runs", async () => {
    const run = async (): Promise<ReturnType<typeof runRegisteredReferenceRewriteCorpus> extends Promise<infer T> ? T : never> => {
      const host = await arrangeSession(FIXTURES);
      const bridgeHost = await createRewriteBridge(host, true);
      const client = await connectClient(bridgeHost.endpoint, EXPECTED_VAULT_ID);
      const observerClient = await connectClient(bridgeHost.endpoint, EXPECTED_VAULT_ID);
      const callTool = callToolOf(client);
      const outcome = await runRegisteredReferenceRewriteCorpus({
        session: makeSession(host, callTool, [], { callTool: callToolOf(observerClient) }),
        record: () => undefined,
        assertion: () => undefined,
      });
      await observerClient.close();
      await client.close();
      return outcome;
    };
    const first = await run();
    const second = await run();
    expect(first.scenarioManifestSha256).toBe(second.scenarioManifestSha256);
    expect(first.seedInventoryDigest).toBe(second.seedInventoryDigest);
    expect(first.beforeInventory).toEqual(second.beforeInventory);
    expect(first.afterInventory).toEqual(second.afterInventory);
    expect(first.moves.map((move) => move.profile)).toEqual(second.moves.map((move) => move.profile));
    expect(first.rejections.map(({ scenario }) => scenario)).toEqual(
      second.rejections.map(({ scenario }) => scenario),
    );
    expect(first.rawBytes.duplicateEqualSpellingsRewritten).toBe(
      second.rawBytes.duplicateEqualSpellingsRewritten,
    );
  }, 120_000);
});
