import { createHash } from "node:crypto";
import {
  mkdir as nodeMkdir,
  readdir as nodeReaddir,
  readFile as nodeReadFile,
  rm as nodeRm,
  stat as nodeStat,
  writeFile as nodeWriteFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

export const FIXED_PERFORMANCE_FIXTURE_MANIFEST_FILENAME = "fixture-manifest.json";
export const FIXED_PERFORMANCE_FIXTURE_MANIFEST_SCHEMA_VERSION = 1;

/**
 * Manifest bytes are UTF-8 canonical JSON with lexicographically sorted object
 * keys, preserved array order, no insignificant whitespace, and one LF. Its
 * SHA-256 covers this serialization with only `manifestSha256` omitted.
 */
export const FIXED_PERFORMANCE_FIXTURE_MANIFEST_SERIALIZATION =
  "UTF-8 canonical JSON; recursively lexicographically sorted object keys; preserved array order; no insignificant whitespace; trailing LF; manifestSha256 excluded from its own digest";

export type FixedPerformanceFixtureName = "read-v1" | "change-v1";
export type FixtureLifecycleOperation = "prepare" | "verify" | "restore" | "cleanup" | "run";

export interface FixtureInventoryEntry {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface FixedPerformanceFixtureManifest {
  readonly schemaVersion: typeof FIXED_PERFORMANCE_FIXTURE_MANIFEST_SCHEMA_VERSION;
  readonly fixtureVersion: FixedPerformanceFixtureName;
  readonly seed: string;
  readonly root: string;
  readonly noteCount: number;
  readonly totalContentBytes: number;
  readonly inventory: readonly FixtureInventoryEntry[];
  readonly workload: Readonly<Record<string, unknown>>;
  readonly manifestSha256: string;
}

export interface FixtureCleanupReport {
  readonly attempted: true;
  readonly cleanupFailed: boolean;
  readonly residualPaths: readonly string[];
}

export interface FixtureInventoryComparison {
  readonly beforeDigest: string;
  readonly afterDigest: string;
  readonly addedPaths: readonly string[];
  readonly removedPaths: readonly string[];
  readonly changedPaths: readonly string[];
}

export interface FixedPerformanceFixtureEvidence {
  readonly schemaVersion: 1;
  readonly operation: FixtureLifecycleOperation;
  readonly fixtureVersion: FixedPerformanceFixtureName;
  readonly seed: string;
  readonly root: string;
  readonly manifestSha256: string;
  readonly beforeInventory: readonly FixtureInventoryEntry[];
  readonly afterInventory: readonly FixtureInventoryEntry[];
  readonly inventoryComparison: FixtureInventoryComparison;
  readonly cleanup: FixtureCleanupReport | null;
  readonly verdict: "passed" | "failed";
  readonly failure: { readonly code: FixtureLifecycleErrorCode; readonly detail: string } | null;
}

export type FixtureLifecycleErrorCode =
  | "target_exists"
  | "fixture_missing"
  | "manifest_invalid"
  | "inventory_mismatch"
  | "setup_failed"
  | "restore_failed"
  | "cleanup_failed"
  | "residual_content"
  | "evidence_exists";

export class FixtureLifecycleError extends Error {
  constructor(
    message: string,
    readonly code: FixtureLifecycleErrorCode,
    readonly evidence: FixedPerformanceFixtureEvidence,
  ) {
    super(message);
    this.name = "FixtureLifecycleError";
  }
}

export interface FixtureDirectoryEntry {
  readonly name: string;
  readonly kind: "file" | "directory" | "other";
}

/** Injectable filesystem seam for deterministic lifecycle fault tests. */
export interface FixedPerformanceFixtureFileSystem {
  exists(path: string): Promise<boolean>;
  /** Creates parent directories and may be called for already-existing paths. */
  mkdir(path: string): Promise<void>;
  /** Creates the fixture target itself and fails if that target already exists. */
  createDirectory(path: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  readdir(path: string): Promise<readonly FixtureDirectoryEntry[]>;
  removeTree(path: string): Promise<void>;
}

const nodeFileSystem: FixedPerformanceFixtureFileSystem = {
  async exists(path) {
    try {
      await nodeStat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  },
  async mkdir(path) {
    await nodeMkdir(path, { recursive: true });
  },
  async createDirectory(path) {
    await nodeMkdir(path);
  },
  async readFile(path) {
    return new Uint8Array(await nodeReadFile(path));
  },
  async writeFile(path, bytes) {
    await nodeWriteFile(path, bytes, { flag: "wx" });
  },
  async readdir(path) {
    const entries = await nodeReaddir(path, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      kind: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other",
    }));
  },
  async removeTree(path) {
    await nodeRm(path, { recursive: true, force: true });
  },
};

export interface FixedPerformanceFixtureOptions {
  /** The fixture is always placed at its spec-defined root below this directory. */
  readonly workingDirectory: string;
  readonly fixture: FixedPerformanceFixtureName;
  readonly fileSystem?: FixedPerformanceFixtureFileSystem;
}

export interface PreparedFixedPerformanceFixture {
  readonly fixturePath: string;
  readonly manifest: FixedPerformanceFixtureManifest;
  readonly evidence: FixedPerformanceFixtureEvidence;
}

export interface VerifiedFixedPerformanceFixture {
  readonly fixturePath: string;
  readonly manifest: FixedPerformanceFixtureManifest;
  readonly evidence: FixedPerformanceFixtureEvidence;
}

export interface RestoredFixedPerformanceFixture {
  readonly fixturePath: string;
  readonly manifest: FixedPerformanceFixtureManifest;
  readonly evidence: FixedPerformanceFixtureEvidence;
}

export interface CleanedFixedPerformanceFixture {
  readonly fixturePath: string;
  readonly evidence: FixedPerformanceFixtureEvidence;
}

interface FixtureFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

interface FixtureDefinition {
  readonly fixtureVersion: FixedPerformanceFixtureName;
  readonly seed: string;
  readonly root: string;
  readonly files: readonly FixtureFile[];
  readonly workload: Readonly<Record<string, unknown>>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compareStrings)
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Canonical fixture data cannot contain undefined, bigint, or functions");
}

function canonicalManifestBytes(manifest: Omit<FixedPerformanceFixtureManifest, "manifestSha256">): Uint8Array {
  return encoder.encode(`${canonicalize(manifest)}\n`);
}

function serializeManifest(manifest: FixedPerformanceFixtureManifest): Uint8Array {
  return encoder.encode(`${canonicalize(manifest)}\n`);
}

function fixtureFile(path: string, content: string): FixtureFile {
  return { path, bytes: encoder.encode(content) };
}

function deterministicFiller(seed: string, length: number): string {
  let result = "";
  let block = 0;
  while (result.length < length) {
    result += sha256(`${seed}:${block}`);
    block += 1;
  }
  return result.slice(0, length);
}

function fixedSizeMarkdown(prefix: string, sizeBytes: number, seed: string): string {
  const prefixBytes = encoder.encode(prefix).length;
  if (prefixBytes >= sizeBytes) throw new Error("Fixed fixture prefix exceeds its declared note size");
  return `${prefix}${deterministicFiller(seed, sizeBytes - prefixBytes - 1)}\n`;
}

function readOrdinaryNote(
  path: string,
  sizeBytes: number,
  ordinal: number,
  target: string,
): FixtureFile {
  const prefix = `---\ntags: [mvp-perf-read-v1-data]\nfixture: read-v1\nordinal: ${ordinal}\n---\n# Read fixture ${ordinal}\n\nDeterministic read corpus note.\n\nOutgoing link: [[${target}]]\n\n`;
  return fixtureFile(path, fixedSizeMarkdown(prefix, sizeBytes, `mvp-perf-read-v1:${path}`));
}

function readEvidenceNote(path: string, ordinal: number): FixtureFile {
  const prefix = `---\ntags: [mvp-perf-read-v1]\nfixture: read-v1\nkind: discovery-evidence\nordinal: ${ordinal}\n---\n# Read evidence ${ordinal}\n\nmvp-perf-read-v1-discovery-token\n\nOutgoing link: [[Small/note-0021]]\n\n`;
  return fixtureFile(path, fixedSizeMarkdown(prefix, 2_608, `mvp-perf-read-v1:${path}`));
}

function buildReadV1(): FixtureDefinition {
  const files: FixtureFile[] = [];
  const evidencePaths: string[] = [];
  for (let ordinal = 1; ordinal <= 20; ordinal += 1) {
    const path = `Evidence/evidence-${String(ordinal).padStart(3, "0")}.md`;
    evidencePaths.push(path);
    files.push(readEvidenceNote(path, ordinal));
  }
  for (let ordinal = 21; ordinal <= 500; ordinal += 1) {
    const path = `Small/note-${String(ordinal).padStart(4, "0")}.md`;
    const next = ordinal === 500 ? "Small/note-0021" : `Small/note-${String(ordinal + 1).padStart(4, "0")}`;
    files.push(readOrdinaryNote(path, 2_608, ordinal, next));
  }
  for (let ordinal = 1; ordinal <= 449; ordinal += 1) {
    const path = `Medium/note-${String(ordinal).padStart(4, "0")}.md`;
    const next = ordinal === 449 ? "Large/note-0001" : `Medium/note-${String(ordinal + 1).padStart(4, "0")}`;
    files.push(readOrdinaryNote(path, 10_240, 500 + ordinal, next));
  }
  for (let ordinal = 1; ordinal <= 50; ordinal += 1) {
    const path = `Large/note-${String(ordinal).padStart(4, "0")}.md`;
    const next = ordinal === 50 ? "Huge/note-0001" : `Large/note-${String(ordinal + 1).padStart(4, "0")}`;
    files.push(readOrdinaryNote(path, 29_316, 949 + ordinal, next));
  }
  files.push(readOrdinaryNote("Huge/note-0001.md", 163_904, 1_000, "Evidence/evidence-001"));
  return {
    fixtureVersion: "read-v1",
    seed: "mvp-perf-read-v1",
    root: ".mvp-perf-fixture/read-v1",
    files,
    workload: {
      discovery: {
        id: "read-v1-discovery",
        pathPrefix: "Evidence/",
        bodyToken: "mvp-perf-read-v1-discovery-token",
        tag: "mvp-perf-read-v1",
        outgoingLink: "Small/note-0021",
        expectedPaths: evidencePaths,
      },
      exactRead: {
        id: "read-v1-exact-read-20",
        orderedPaths: evidencePaths,
        expectedContentBytes: 20 * 2_608,
        continuation: "none",
      },
    },
  };
}

function buildChangeV1(): FixtureDefinition {
  const files: FixtureFile[] = [];
  const paths: string[] = [];
  const operations: Array<Record<string, string>> = [];
  for (let ordinal = 1; ordinal <= 20; ordinal += 1) {
    const filename = `change-${String(ordinal).padStart(3, "0")}.md`;
    const path = `Changes/${filename}`;
    const next = `Changes/change-${String(ordinal === 20 ? 1 : ordinal + 1).padStart(3, "0")}`;
    const oldString = `mvp-perf-change-v1-old-${String(ordinal).padStart(3, "0")}`;
    const newString = `mvp-perf-change-v1-new-${String(ordinal).padStart(3, "0")}`;
    const prefix = `---\nfixture: change-v1\ntags: [mvp-perf-change-v1]\nordinal: ${ordinal}\n---\n# Change fixture ${ordinal}\n\nPre-parsed outgoing link: [[${next}]]\n\nreplace_exact target: ${oldString}\n\n`;
    files.push(fixtureFile(path, fixedSizeMarkdown(prefix, 4_096, `mvp-perf-change-v1:${path}`)));
    paths.push(path);
    operations.push({
      path,
      selector: "plain_body",
      operation: "replace_exact",
      oldString,
      newString,
    });
  }
  return {
    fixtureVersion: "change-v1",
    seed: "mvp-perf-change-v1",
    root: ".mvp-perf-fixture/change-v1",
    files,
    workload: {
      changeSet: {
        id: "change-v1-replace-exact-20",
        operations,
        sourceNoteClosure: paths,
      },
    },
  };
}

function definitionFor(name: FixedPerformanceFixtureName): FixtureDefinition {
  return name === "read-v1" ? buildReadV1() : buildChangeV1();
}

function manifestFor(definition: FixtureDefinition): FixedPerformanceFixtureManifest {
  const inventory = definition.files
    .map(({ path, bytes }) => ({ path, sha256: sha256(bytes), sizeBytes: bytes.length }))
    .sort((left, right) => compareStrings(left.path, right.path));
  const withoutDigest = {
    schemaVersion: FIXED_PERFORMANCE_FIXTURE_MANIFEST_SCHEMA_VERSION,
    fixtureVersion: definition.fixtureVersion,
    seed: definition.seed,
    root: definition.root,
    noteCount: inventory.length,
    totalContentBytes: inventory.reduce((total, entry) => total + entry.sizeBytes, 0),
    inventory,
    workload: definition.workload,
  } as const;
  return {
    ...withoutDigest,
    manifestSha256: sha256(canonicalManifestBytes(withoutDigest)),
  };
}

function targetPath(options: Pick<FixedPerformanceFixtureOptions, "workingDirectory" | "fixture">): string {
  return join(options.workingDirectory, ...definitionFor(options.fixture).root.split("/"));
}

function inventoryDigest(inventory: readonly FixtureInventoryEntry[]): string {
  const serialized = inventory
    .slice()
    .sort((left, right) => compareStrings(left.path, right.path))
    .map(({ path, sha256: digest, sizeBytes }) => `${digest}  ${sizeBytes}  ${path}`)
    .join("\n");
  return sha256(`${serialized}\n`);
}

export function compareFixtureInventories(
  before: readonly FixtureInventoryEntry[],
  after: readonly FixtureInventoryEntry[],
): FixtureInventoryComparison {
  const beforeByPath = new Map(before.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.map((entry) => [entry.path, entry]));
  return {
    beforeDigest: inventoryDigest(before),
    afterDigest: inventoryDigest(after),
    addedPaths: [...afterByPath.keys()].filter((path) => !beforeByPath.has(path)).sort(compareStrings),
    removedPaths: [...beforeByPath.keys()].filter((path) => !afterByPath.has(path)).sort(compareStrings),
    changedPaths: [...beforeByPath.keys()]
      .filter((path) => afterByPath.has(path) && beforeByPath.get(path)!.sha256 !== afterByPath.get(path)!.sha256)
      .sort(compareStrings),
  };
}

async function snapshotFixtureInventory(
  root: string,
  fileSystem: FixedPerformanceFixtureFileSystem,
): Promise<FixtureInventoryEntry[]> {
  const entries: FixtureInventoryEntry[] = [];
  const walk = async (directory: string): Promise<void> => {
    const children = await fileSystem.readdir(directory);
    for (const child of [...children].sort((left, right) => compareStrings(left.name, right.name))) {
      const absolutePath = join(directory, child.name);
      if (child.kind === "directory") {
        await walk(absolutePath);
      } else if (child.kind === "file") {
        const bytes = await fileSystem.readFile(absolutePath);
        const path = relative(root, absolutePath).split(sep).join("/");
        entries.push({ path, sha256: sha256(bytes), sizeBytes: bytes.length });
      } else {
        throw new Error(`Fixture inventory refuses unsupported filesystem entry: ${child.name}`);
      }
    }
  };
  await walk(root);
  return entries.sort((left, right) => compareStrings(left.path, right.path));
}

async function writeFixtureFile(
  root: string,
  file: FixtureFile,
  fileSystem: FixedPerformanceFixtureFileSystem,
): Promise<void> {
  const destination = join(root, ...file.path.split("/"));
  await fileSystem.mkdir(dirname(destination));
  await fileSystem.writeFile(destination, file.bytes);
}

function manifestPath(root: string): string {
  return join(root, FIXED_PERFORMANCE_FIXTURE_MANIFEST_FILENAME);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isInventoryEntry(value: unknown): value is FixtureInventoryEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.path === "string" && isSha256(entry.sha256) && typeof entry.sizeBytes === "number" && Number.isSafeInteger(entry.sizeBytes) && entry.sizeBytes >= 0;
}

function parseManifest(bytes: Uint8Array, expected: FixedPerformanceFixtureManifest): FixedPerformanceFixtureManifest {
  let parsed: unknown;
  let raw: string;
  try {
    raw = decoder.decode(bytes);
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Fixture manifest is not valid UTF-8 JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Fixture manifest is not an object");
  }
  const manifest = parsed as Record<string, unknown>;
  const expectedKeys = [
    "fixtureVersion",
    "inventory",
    "manifestSha256",
    "noteCount",
    "root",
    "schemaVersion",
    "seed",
    "totalContentBytes",
    "workload",
  ];
  if (Object.keys(manifest).sort(compareStrings).join("\n") !== expectedKeys.join("\n")) {
    throw new Error("Fixture manifest does not have the closed canonical shape");
  }
  if (
    manifest.schemaVersion !== FIXED_PERFORMANCE_FIXTURE_MANIFEST_SCHEMA_VERSION ||
    manifest.fixtureVersion !== expected.fixtureVersion ||
    manifest.seed !== expected.seed ||
    manifest.root !== expected.root ||
    manifest.noteCount !== expected.noteCount ||
    manifest.totalContentBytes !== expected.totalContentBytes ||
    !Array.isArray(manifest.inventory) ||
    !manifest.inventory.every(isInventoryEntry) ||
    typeof manifest.workload !== "object" ||
    manifest.workload === null ||
    Array.isArray(manifest.workload) ||
    !isSha256(manifest.manifestSha256)
  ) {
    throw new Error("Fixture manifest identity or shape is invalid");
  }
  const typed = manifest as unknown as FixedPerformanceFixtureManifest;
  const withoutDigest = {
    schemaVersion: typed.schemaVersion,
    fixtureVersion: typed.fixtureVersion,
    seed: typed.seed,
    root: typed.root,
    noteCount: typed.noteCount,
    totalContentBytes: typed.totalContentBytes,
    inventory: typed.inventory,
    workload: typed.workload,
  };
  if (raw !== decoder.decode(serializeManifest(typed))) {
    throw new Error("Fixture manifest does not use canonical serialization");
  }
  if (sha256(canonicalManifestBytes(withoutDigest)) !== typed.manifestSha256) {
    throw new Error("Fixture manifest self-hash does not match");
  }
  if (canonicalize(typed) !== canonicalize(expected)) {
    throw new Error("Fixture manifest differs from the fixed fixture definition");
  }
  return typed;
}

function withoutManifest(inventory: readonly FixtureInventoryEntry[]): FixtureInventoryEntry[] {
  return inventory.filter((entry) => entry.path !== FIXED_PERFORMANCE_FIXTURE_MANIFEST_FILENAME);
}

function inventoriesMatch(
  left: readonly FixtureInventoryEntry[],
  right: readonly FixtureInventoryEntry[],
): boolean {
  return canonicalize(left) === canonicalize(right);
}

function createEvidence(
  operation: FixtureLifecycleOperation,
  definition: FixtureDefinition,
  manifest: FixedPerformanceFixtureManifest,
  beforeInventory: readonly FixtureInventoryEntry[],
  afterInventory: readonly FixtureInventoryEntry[],
  verdict: FixedPerformanceFixtureEvidence["verdict"],
  failure: FixedPerformanceFixtureEvidence["failure"],
  cleanup: FixtureCleanupReport | null = null,
): FixedPerformanceFixtureEvidence {
  return {
    schemaVersion: 1,
    operation,
    fixtureVersion: definition.fixtureVersion,
    seed: definition.seed,
    root: definition.root,
    manifestSha256: manifest.manifestSha256,
    beforeInventory,
    afterInventory,
    inventoryComparison: compareFixtureInventories(beforeInventory, afterInventory),
    cleanup,
    verdict,
    failure,
  };
}

async function cleanupRoot(
  root: string,
  fileSystem: FixedPerformanceFixtureFileSystem,
): Promise<FixtureCleanupReport> {
  let cleanupFailed = false;
  try {
    await fileSystem.removeTree(root);
  } catch {
    cleanupFailed = true;
  }
  const residualPaths: string[] = [];
  if (await fileSystem.exists(root)) {
    try {
      const inventory = await snapshotFixtureInventory(root, fileSystem);
      residualPaths.push(...inventory.map((entry) => entry.path));
      if (inventory.length === 0) residualPaths.push("/");
    } catch {
      residualPaths.push("/");
    }
  }
  return { attempted: true, cleanupFailed, residualPaths: residualPaths.sort(compareStrings) };
}

function lifecycleError(
  message: string,
  code: FixtureLifecycleErrorCode,
  evidence: FixedPerformanceFixtureEvidence,
): FixtureLifecycleError {
  return new FixtureLifecycleError(message, code, evidence);
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Creates the fixed corpus only when its complete target root is absent. */
export async function prepareFixedPerformanceFixture(
  options: FixedPerformanceFixtureOptions,
): Promise<PreparedFixedPerformanceFixture> {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const definition = definitionFor(options.fixture);
  const manifest = manifestFor(definition);
  const root = targetPath(options);
  const beforeInventory: FixtureInventoryEntry[] = [];
  if (await fileSystem.exists(root)) {
    const evidence = createEvidence(
      "prepare",
      definition,
      manifest,
      beforeInventory,
      beforeInventory,
      "failed",
      { code: "target_exists", detail: "Fixture target already exists" },
    );
    throw lifecycleError(`Refusing to overwrite existing fixture target: ${root}`, "target_exists", evidence);
  }
  let rootCreated = false;
  try {
    await fileSystem.mkdir(dirname(root));
    try {
      await fileSystem.createDirectory(root);
    } catch (error) {
      if (await fileSystem.exists(root)) {
        const evidence = createEvidence(
          "prepare",
          definition,
          manifest,
          beforeInventory,
          beforeInventory,
          "failed",
          { code: "target_exists", detail: "Fixture target was created concurrently" },
        );
        throw lifecycleError(
          `Refusing to overwrite existing fixture target: ${root}`,
          "target_exists",
          evidence,
        );
      }
      throw error;
    }
    rootCreated = true;
    for (const file of definition.files) await writeFixtureFile(root, file, fileSystem);
    await fileSystem.writeFile(manifestPath(root), serializeManifest(manifest));
    const afterInventory = await snapshotFixtureInventory(root, fileSystem);
    if (!inventoriesMatch(withoutManifest(afterInventory), manifest.inventory)) {
      throw new Error("Generated fixture inventory did not match its canonical manifest");
    }
    return {
      fixturePath: root,
      manifest,
      evidence: createEvidence("prepare", definition, manifest, beforeInventory, afterInventory, "passed", null),
    };
  } catch (error) {
    if (error instanceof FixtureLifecycleError && !rootCreated) throw error;
    const cleanup = rootCreated ? await cleanupRoot(root, fileSystem) : null;
    const afterInventory = (await fileSystem.exists(root)) ? await snapshotFixtureInventory(root, fileSystem).catch(() => []) : [];
    const code: FixtureLifecycleErrorCode = cleanup?.cleanupFailed === true
      ? "cleanup_failed"
      : cleanup !== null && cleanup.residualPaths.length > 0
        ? "residual_content"
        : "setup_failed";
    const evidence = createEvidence(
      "prepare",
      definition,
      manifest,
      beforeInventory,
      afterInventory,
      "failed",
      { code, detail: asMessage(error) },
      cleanup,
    );
    throw lifecycleError(`Fixed fixture setup failed: ${asMessage(error)}`, code, evidence);
  }
}

/** Validates canonical manifest bytes, the self-hash, and every expected file. */
export async function verifyFixedPerformanceFixture(
  options: FixedPerformanceFixtureOptions,
): Promise<VerifiedFixedPerformanceFixture> {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const definition = definitionFor(options.fixture);
  const expected = manifestFor(definition);
  const root = targetPath(options);
  let beforeInventory: FixtureInventoryEntry[] = [];
  try {
    if (!(await fileSystem.exists(root))) throw new Error("Fixture target is absent");
    beforeInventory = await snapshotFixtureInventory(root, fileSystem);
    const manifest = parseManifest(await fileSystem.readFile(manifestPath(root)), expected);
    if (!inventoriesMatch(withoutManifest(beforeInventory), manifest.inventory)) {
      throw new Error("Fixture files do not match the canonical manifest inventory");
    }
    return {
      fixturePath: root,
      manifest,
      evidence: createEvidence("verify", definition, expected, beforeInventory, beforeInventory, "passed", null),
    };
  } catch (error) {
    const message = asMessage(error);
    const code: FixtureLifecycleErrorCode = !(await fileSystem.exists(root))
      ? "fixture_missing"
      : message.includes("inventory")
        ? "inventory_mismatch"
        : "manifest_invalid";
    const evidence = createEvidence(
      "verify",
      definition,
      expected,
      beforeInventory,
      beforeInventory,
      "failed",
      { code, detail: message },
    );
    throw lifecycleError(`Fixed fixture verification failed: ${message}`, code, evidence);
  }
}

/** Restores every expected byte and removes all additions before a measured sample. */
export async function restoreFixedPerformanceFixture(
  options: FixedPerformanceFixtureOptions,
): Promise<RestoredFixedPerformanceFixture> {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const definition = definitionFor(options.fixture);
  const manifest = manifestFor(definition);
  const root = targetPath(options);
  let beforeInventory: FixtureInventoryEntry[] = [];
  try {
    if (!(await fileSystem.exists(root))) throw new Error("Fixture target is absent");
    beforeInventory = await snapshotFixtureInventory(root, fileSystem);
    await fileSystem.removeTree(root);
    await fileSystem.mkdir(dirname(root));
    await fileSystem.createDirectory(root);
    for (const file of definition.files) await writeFixtureFile(root, file, fileSystem);
    await fileSystem.writeFile(manifestPath(root), serializeManifest(manifest));
    const afterInventory = await snapshotFixtureInventory(root, fileSystem);
    if (!inventoriesMatch(withoutManifest(afterInventory), manifest.inventory)) {
      throw new Error("Restored fixture inventory did not match its canonical manifest");
    }
    return {
      fixturePath: root,
      manifest,
      evidence: createEvidence("restore", definition, manifest, beforeInventory, afterInventory, "passed", null),
    };
  } catch (error) {
    const cleanup = (await fileSystem.exists(root)) ? await cleanupRoot(root, fileSystem) : null;
    const afterInventory = (await fileSystem.exists(root)) ? await snapshotFixtureInventory(root, fileSystem).catch(() => []) : [];
    const code: FixtureLifecycleErrorCode = cleanup?.cleanupFailed === true
      ? "cleanup_failed"
      : cleanup !== null && cleanup.residualPaths.length > 0
        ? "residual_content"
        : "restore_failed";
    const evidence = createEvidence(
      "restore",
      definition,
      manifest,
      beforeInventory,
      afterInventory,
      "failed",
      { code, detail: asMessage(error) },
      cleanup,
    );
    throw lifecycleError(`Fixed fixture restore failed: ${asMessage(error)}`, code, evidence);
  }
}

/** Removes a generated fixture root and fails closed if removal leaves any residue. */
export async function cleanupFixedPerformanceFixture(
  options: FixedPerformanceFixtureOptions,
): Promise<CleanedFixedPerformanceFixture> {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const definition = definitionFor(options.fixture);
  const manifest = manifestFor(definition);
  const root = targetPath(options);
  const beforeInventory = (await fileSystem.exists(root))
    ? await snapshotFixtureInventory(root, fileSystem)
    : [];
  const cleanup = await cleanupRoot(root, fileSystem);
  const afterInventory = (await fileSystem.exists(root))
    ? await snapshotFixtureInventory(root, fileSystem).catch(() => [])
    : [];
  if (cleanup.cleanupFailed || cleanup.residualPaths.length > 0) {
    const code: FixtureLifecycleErrorCode = cleanup.cleanupFailed ? "cleanup_failed" : "residual_content";
    const evidence = createEvidence(
      "cleanup",
      definition,
      manifest,
      beforeInventory,
      afterInventory,
      "failed",
      { code, detail: "Fixture cleanup did not remove the entire generated root" },
      cleanup,
    );
    throw lifecycleError("Fixed fixture cleanup failed or left residual content", code, evidence);
  }
  return {
    fixturePath: root,
    evidence: createEvidence("cleanup", definition, manifest, beforeInventory, afterInventory, "passed", null, cleanup),
  };
}

export interface FixedPerformanceFixtureRunContext {
  readonly fixturePath: string;
  readonly manifest: FixedPerformanceFixtureManifest;
  /** Call outside a measured interval before every sample. */
  restore(): Promise<RestoredFixedPerformanceFixture>;
}

export interface FixedPerformanceFixtureRunResult<T> {
  readonly value: T;
  readonly evidence: FixedPerformanceFixtureEvidence;
}

/**
 * Runs a fixture action with unconditional cleanup. The action receives only a
 * restore seam, so benchmark callers place restore before—not inside—their clocks.
 */
export async function runFixedPerformanceFixture<T>(
  options: FixedPerformanceFixtureOptions,
  action: (context: FixedPerformanceFixtureRunContext) => Promise<T>,
): Promise<FixedPerformanceFixtureRunResult<T>> {
  const definition = definitionFor(options.fixture);
  const manifest = manifestFor(definition);
  const root = targetPath(options);
  let setup: PreparedFixedPerformanceFixture | undefined;
  let value: T | undefined;
  let primaryError: unknown;
  try {
    setup = await prepareFixedPerformanceFixture(options);
    await verifyFixedPerformanceFixture(options);
    value = await action({
      fixturePath: setup.fixturePath,
      manifest: setup.manifest,
      restore: () => restoreFixedPerformanceFixture(options),
    });
  } catch (error) {
    primaryError = error;
  }

  let cleanup: CleanedFixedPerformanceFixture | undefined;
  let cleanupError: unknown;
  if (setup !== undefined) {
    try {
      cleanup = await cleanupFixedPerformanceFixture(options);
    } catch (error) {
      cleanupError = error;
    }
  }

  const baseEvidence = cleanup?.evidence ??
    (cleanupError instanceof FixtureLifecycleError ? cleanupError.evidence : undefined) ??
    (primaryError instanceof FixtureLifecycleError ? primaryError.evidence : undefined) ??
    createEvidence("run", definition, manifest, [], [], "failed", {
      code: "setup_failed",
      detail: "Fixture run did not begin",
    });
  const failure = cleanupError instanceof FixtureLifecycleError
    ? { code: cleanupError.code, detail: cleanupError.message }
    : primaryError instanceof FixtureLifecycleError
      ? { code: primaryError.code, detail: primaryError.message }
      : primaryError === undefined
        ? null
        : { code: "setup_failed" as const, detail: asMessage(primaryError) };
  const evidence = {
    ...baseEvidence,
    operation: "run" as const,
    verdict: failure === null ? "passed" as const : "failed" as const,
    failure,
  };
  if (failure !== null) {
    throw lifecycleError(`Fixed fixture run failed: ${failure.detail}`, failure.code, evidence);
  }
  return { value: value as T, evidence };
}

/** Writes one closed evidence record without overwriting an earlier record. */
export async function writeFixedPerformanceFixtureEvidence(
  evidencePath: string,
  evidence: FixedPerformanceFixtureEvidence,
): Promise<void> {
  await nodeMkdir(dirname(evidencePath), { recursive: true });
  await nodeWriteFile(evidencePath, `${canonicalize(evidence)}\n`, { encoding: "utf8", flag: "wx" });
}

export function fixedPerformanceFixtureTargetPath(options: Pick<FixedPerformanceFixtureOptions, "workingDirectory" | "fixture">): string {
  return targetPath(options);
}

export function fixedPerformanceFixtureManifest(name: FixedPerformanceFixtureName): FixedPerformanceFixtureManifest {
  return manifestFor(definitionFor(name));
}
