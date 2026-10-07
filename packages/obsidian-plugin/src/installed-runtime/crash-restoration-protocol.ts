import { createHash, randomBytes } from "node:crypto";
import { link, lstat, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { open } from "node:fs/promises";
import { openRecoveryJournal } from "../recovery-journal.js";

import { z } from "zod";

import {
  installedRuntimeAcceptanceDescriptorSchema,
  isPathInside,
  type InstalledRuntimeAcceptanceDescriptor,
  crashRestorationCommandSchema,
  installedCrashScenarios,
  installedCrashScenarioSchema,
  installedCrashPoints,
  loadInstalledRuntimeAcceptanceDescriptor,
  type InstalledCrashPoint,
  type InstalledCrashKind,
} from "./acceptance-driver-protocol.js";
import { createNoteCorpusProfile } from "../corpus/create-note-corpus.js";
import { replaceExactCorpusProfile, replaceWholeCorpusProfile } from "../corpus/edit-body-corpus.js";
import { copyAttachmentCorpusProfile, moveAttachmentCorpusProfile } from "../corpus/attachment-corpus.js";
export { crashRestorationCommandSchema, installedCrashScenarios };
export type { InstalledCrashPoint, InstalledCrashKind };

export function crashBoundaryPhase(point: InstalledCrashPoint): "PREPARED" | "COMMITTED" | "ROLLED_BACK" | null {
  if (point === "before_prepared") return null;
  if (point === "after_committed") return "COMMITTED";
  if (point === "after_rolled_back") return "ROLLED_BACK";
  return "PREPARED";
}
export function crashProfile(kind: InstalledCrashKind) {
  if (kind === "copy_attachment" || kind === "move_attachment") {
    const base = kind === "copy_attachment" ? copyAttachmentCorpusProfile() : moveAttachmentCorpusProfile();
    const target = kind === "copy_attachment" ? "Copy" : "Move";
    const destinationPath = `Corpus/Attachments/${target}-target/Nested/${target}-destination.bin`;
    return { ...base, files: base.files.map(file => file.originalBytes === null ? { ...file, path: destinationPath } : file), buildSubmitInput: (seed: string) => {
      const input = base.buildSubmitInput(seed);
      return { ...input, operations: (input.operations as Record<string, unknown>[]).map(operation => ({ ...operation, destinationPath })) };
    } };
  }
  return kind === "create_note" ? createNoteCorpusProfile() : kind === "edit_body" ? replaceExactCorpusProfile() : replaceWholeCorpusProfile();
}
export function crashScenarioParts(scenario: CrashRestorationCommand["scenario"]): { kind: InstalledCrashKind; point: InstalledCrashPoint } {
  const [kind, point] = scenario.split("/");
  return { kind: kind as InstalledCrashKind, point: point as InstalledCrashPoint };
}
export const crashDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const crashRestorationBoundarySchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  vaultId: z.string().min(1),
  endpoint: z.string().url(),
  scenario: installedCrashScenarioSchema,
  candidateBundleSha256: digestSchema,
  installedMainSha256: digestSchema,
  capabilityToken: digestSchema,
  submissionKey: z.string().min(1),
  sequence: z.number().int().positive(),
  point: z.enum(installedCrashPoints),
  journalPhase: z.enum(["PREPARED", "COMMITTED", "ROLLED_BACK"]).nullable(),
  frameSha256: digestSchema.nullable(),
  inventorySha256: digestSchema,
}).strict().refine(report =>
  report.scenario.endsWith(`/${report.point}`) &&
  report.journalPhase === crashBoundaryPhase(report.point) &&
  (report.journalPhase === null ? report.frameSha256 === null : report.frameSha256 !== null),
  "Crash boundary scenario, point and durable phase must agree");

export type CrashRestorationCommand = z.infer<typeof crashRestorationCommandSchema>;
export type CrashRestorationBoundaryReport = z.infer<typeof crashRestorationBoundarySchema>;

export interface CrashInventoryEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly bytes?: number;
  readonly sha256?: string;
}
/** Complete public footprint, not just the primary note; never follows symlinks. */
export async function crashInventory(vaultPath: string, configDirectoryName = ".obsidian"): Promise<CrashInventoryEntry[]> {
  const entries: CrashInventoryEntry[] = [];
  const visit = async (relative: string): Promise<void> => {
    for (const name of (await readdir(join(vaultPath, relative))).sort()) {
      if (relative === "" && (name === ".llm-wiki" || name === configDirectoryName)) continue;
      const path = relative === "" ? name : `${relative}/${name}`;
      const facts = await lstat(join(vaultPath, path));
      if (facts.isSymbolicLink() || (!facts.isDirectory() && !facts.isFile())) throw new Error("Crash inventory contains an unsupported path");
      if (facts.isDirectory()) { entries.push({ path, kind: "directory" }); await visit(path); }
      else { const bytes = await readFile(join(vaultPath, path)); entries.push({ path, kind: "file", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }); }
    }
  };
  await visit("");
  return entries.sort((a, b) => a.path.localeCompare(b.path, "en"));
}
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export function crashAttachmentDirectories(kind: InstalledCrashKind): readonly string[] {
  if (kind !== "copy_attachment" && kind !== "move_attachment") return [];
  const target = kind === "copy_attachment" ? "Copy" : "Move";
  return [`Corpus/Attachments/${target}-target`, `Corpus/Attachments/${target}-target/Nested`];
}

export function verifyCrashInventory(before: readonly CrashInventoryEntry[], actual: readonly CrashInventoryEntry[], kind: InstalledCrashKind, state: "original" | "committed", point?: InstalledCrashPoint): void {
  const profile = crashProfile(kind);
  if (kind === "copy_attachment" || kind === "move_attachment") {
    let applied = state === "committed";
    let directories = applied ? [...crashAttachmentDirectories(kind)] : [];
    if (point?.startsWith("after_mutation:")) {
      const index = Number(point.split(":")[1]);
      applied = index === 2;
      directories = crashAttachmentDirectories(kind).slice(0, index + 1);
    }
    if (point?.startsWith("after_rollback_mutation:")) {
      const index = Number(point.split(":")[1]);
      applied = false;
      directories = crashAttachmentDirectories(kind).slice(0, Math.max(0, (kind === "copy_attachment" ? 3 : 2) - index));
    }
    const expected = before.filter(entry => !profile.files.some(file => file.path === entry.path));
    for (const fixture of profile.files) {
      const bytes = applied ? fixture.committedBytes : fixture.originalBytes;
      if (bytes !== null) expected.push({ path: fixture.path, kind: "file", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    expected.push(...directories.map(path => ({ path, kind: "directory" as const })));
    const sorted = (entries: readonly CrashInventoryEntry[]) => [...entries].sort((a, b) => a.path.localeCompare(b.path, "en"));
    if (!same(sorted(expected), sorted(actual))) throw new Error("Installed crash whole-state inventory mismatch");
    return;
  }
  let expected = [...before];
  const fixture = profile.files[0]!;
  let committed = state === "committed";
  let directories: string[] = committed && kind === "create_note" ? ["Corpus", "Corpus/Notes"] : [];
  if (point !== undefined && kind === "create_note") {
    if (point === "after_mutation:0") { directories = ["Corpus"]; committed = false; }
    if (point === "after_mutation:1") { directories = ["Corpus", "Corpus/Notes"]; committed = false; }
    if (point === "after_rollback_mutation:0") { directories = ["Corpus", "Corpus/Notes"]; committed = false; }
    if (point === "after_rollback_mutation:1") { directories = ["Corpus"]; committed = false; }
    if (point === "after_rollback_mutation:2") { directories = []; committed = false; }
  }
  if (committed) {
    expected = expected.filter(entry => entry.path !== fixture.path);
    const bytes = fixture.committedBytes!;
    expected.push({ path: fixture.path, kind: "file", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  for (const path of directories) expected.push({ path, kind: "directory" });
  const sorted = (entries: readonly CrashInventoryEntry[]) => [...entries].sort((a, b) => a.path.localeCompare(b.path, "en"));
  if (!same(sorted(expected), sorted(actual))) throw new Error("Installed crash whole-state inventory mismatch");
}
export function verifyCrashPublicProof(record: unknown, beforeRecord: unknown, kind: InstalledCrashKind, state: "intent_applied" | "intent_not_applied", input?: { operations: readonly { operationId: string }[] }): void {
  const before = beforeRecord as { changeSetId?: string; preview?: { requestedEffects: unknown[]; derivedEffects: unknown[]; paths: unknown[] } };
  const actual = record as { changeSetId?: string; state?: string; preview?: unknown; requestedEffects?: unknown[]; derivedEffects?: unknown[]; paths?: unknown[] };
  const preview = before.preview;
  const profile = crashProfile(kind);
  const fixture = profile.files[0]!;
  const version = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const effect = preview?.requestedEffects[0] as { operationId?: string; kind?: string; projectedOutcome?: string } | undefined;
  if (input !== undefined && effect?.operationId !== input.operations[0]?.operationId) throw new Error("Installed crash public proof targets another operation");
  if (kind === "copy_attachment" || kind === "move_attachment") {
    const typed = (bytes: Uint8Array | null) => bytes === null ? { kind: "absent" } : { kind: "attachment", sha256: createHash("sha256").update(bytes).digest("hex") };
    const directories = crashAttachmentDirectories(kind);
    const paths = [...directories.map(path => ({ path, preState: { kind: "absent" }, projectedFinalState: { kind: "directory" }, projectedOutcome: "changed" })), ...profile.files.map(file => ({ path: file.path, preState: typed(file.originalBytes), projectedFinalState: typed(file.committedBytes), projectedOutcome: same(typed(file.originalBytes), typed(file.committedBytes)) ? "unchanged" : "changed" }))].sort((a, b) => a.path.localeCompare(b.path, "en"));
    const derived = directories.map(path => ({ operationId: `derived/${effect?.operationId}/directory/${path}`, causedByOperationId: effect?.operationId, kind: "create_directory", projectedOutcome: "changed" }));
    if (effect?.kind !== kind || effect.projectedOutcome !== "changed" || typeof effect.operationId !== "string" || !same(preview?.paths, paths) || !same(preview?.derivedEffects, derived) || preview?.requestedEffects.length !== 1 || actual.changeSetId !== before.changeSetId || actual.state !== state || !same(actual.preview, preview)) throw new Error("Installed crash fixed fixture public proof mismatch");
    if (state === "intent_applied") {
      const effects = (items: readonly unknown[]) => items.map(raw => { const { projectedOutcome, ...rest } = raw as Record<string, unknown>; return { ...rest, outcome: projectedOutcome }; });
      const finalPaths = paths.map(({ path, projectedOutcome, projectedFinalState }) => ({ path, outcome: projectedOutcome, finalState: projectedFinalState }));
      if (!same(actual.requestedEffects, effects(preview.requestedEffects)) || !same(actual.derivedEffects, effects(derived)) || !same(actual.paths, finalPaths)) throw new Error("Installed crash complete public proof mismatch");
    }
    return;
  }
  const paths = [...(kind === "create_note" ? ["Corpus", "Corpus/Notes"].map(path => ({ path, preState: { kind: "absent" }, projectedFinalState: { kind: "directory" }, projectedOutcome: "changed" })) : []), { path: fixture.path, preState: fixture.originalBytes === null ? { kind: "absent" } : { kind: "markdown", contentVersion: version(fixture.originalBytes) }, projectedFinalState: { kind: "markdown", contentVersion: version(fixture.committedBytes!) }, projectedOutcome: "changed" }];
  const derived = kind === "create_note" ? ["Corpus", "Corpus/Notes"].map(path => ({ operationId: `derived/${effect?.operationId}/directory/${path}`, causedByOperationId: effect?.operationId, kind: "create_directory", projectedOutcome: "changed" })) : [];
  if (effect?.kind !== (kind === "create_note" ? "create_note" : "edit_body") || effect.projectedOutcome !== "changed" || typeof effect.operationId !== "string" || !same(preview?.paths, paths) || !same(preview?.derivedEffects, derived)) throw new Error("Installed crash fixed fixture public proof mismatch");
  if (preview === undefined || preview.requestedEffects.length !== 1 || preview.paths.length !== (kind === "create_note" ? 3 : 1) || preview.derivedEffects.length !== (kind === "create_note" ? 2 : 0) || actual.changeSetId !== before.changeSetId || actual.state !== state || !same(actual.preview, preview)) throw new Error("Installed crash complete public proof mismatch");
  if (state === "intent_applied") {
    const effect = (raw: unknown) => { const { projectedOutcome, ...rest } = raw as Record<string, unknown>; return { ...rest, outcome: projectedOutcome }; };
    const paths = preview.paths.map(raw => { const { path, projectedOutcome, projectedFinalState } = raw as Record<string, unknown>; return { path, outcome: projectedOutcome, finalState: projectedFinalState }; });
    if (!same(actual.requestedEffects, preview.requestedEffects.map(effect)) || !same(actual.derivedEffects, preview.derivedEffects.map(effect)) || !same(actual.paths, paths)) throw new Error("Installed crash complete public proof mismatch");
  }
}

export function crashRestorationBoundaryPath(reportDirectory: string, crashPoint: InstalledCrashPoint = "after_prepared", mutationKind: InstalledCrashKind = "create_note", submissionKey?: string): string {
  const prefix = mutationKind === "create_note" ? "" : `${mutationKind.replaceAll("_", "-")}-`;
  const suffix = submissionKey === undefined ? "" : `-${crashDigest(submissionKey).slice(0, 24)}`;
  return join(reportDirectory, `crash-restoration-${prefix}${crashPoint.replace(/[^A-Za-z0-9-]/gu, "-")}${suffix}-boundary.json`);
}

export async function requestInstalledCrashRestorationScenario(options: {
  readonly descriptorPath: string;
  readonly descriptor: InstalledRuntimeAcceptanceDescriptor;
  readonly expectedVaultId: string;
  readonly endpoint: URL;
  readonly input: unknown;
  readonly crashPoint: InstalledCrashPoint;
  readonly mutationKind?: InstalledCrashKind;
  readonly recovery?: { readonly changeSetId: string; readonly frameSha256: string };
}): Promise<number> {
  if (options.endpoint.protocol !== "http:" || options.endpoint.hostname !== "127.0.0.1") {
    throw new Error("Installed acceptance commands require the loopback endpoint");
  }
  const current = installedRuntimeAcceptanceDescriptorSchema.parse(
    JSON.parse(await readFile(options.descriptorPath, "utf8")) as unknown,
  );
  assertDescriptorSame(current, options.descriptor);
  const parsedInput = options.input as { submissionKey?: unknown };
  if (typeof parsedInput.submissionKey !== "string" || parsedInput.submissionKey.length === 0) {
    throw new Error("Crash restoration command requires a Submission Key");
  }
  const command = crashRestorationCommandSchema.parse({
    sequence: current.command.sequence + 1,
    capabilityToken: current.capabilityToken,
    action: "run-crash-restoration-scenario",
    scenario: `${options.mutationKind ?? "create_note"}/${options.crashPoint}`,
    expectedVaultId: options.expectedVaultId,
    endpoint: options.endpoint.toString(),
    submissionKey: parsedInput.submissionKey,
    input: options.input,
    ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
  });
  const updated = { ...current, command };
  const temp = `${options.descriptorPath}.${randomBytes(16).toString("hex")}.next`;
  await writeFile(temp, `${JSON.stringify(updated)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try { await rename(temp, options.descriptorPath); }
  finally { await rm(temp, { force: true }); }
  return command.sequence;
}

export async function writeCrashRestorationBoundaryReport(options: {
  readonly descriptor: InstalledRuntimeAcceptanceDescriptor;
  readonly command: CrashRestorationCommand;
  readonly journalPhase: "PREPARED" | "COMMITTED" | "ROLLED_BACK" | null;
  readonly frameSha256: string | null;
  readonly inventorySha256: string;
}): Promise<void> {
  if (options.command.capabilityToken !== options.descriptor.capabilityToken) {
    throw new Error("Installed crash marker command capability changed");
  }
  const report = crashRestorationBoundarySchema.parse({
    schemaVersion: 1,
    runId: options.descriptor.runId,
    vaultId: options.command.expectedVaultId,
    endpoint: options.command.endpoint,
    scenario: options.command.scenario,
    candidateBundleSha256: options.descriptor.candidateBundleSha256,
    installedMainSha256: options.descriptor.installedMainSha256,
    capabilityToken: options.descriptor.capabilityToken,
    submissionKey: options.command.submissionKey,
    sequence: options.command.sequence,
    point: crashScenarioParts(options.command.scenario).point,
    journalPhase: options.journalPhase,
    frameSha256: options.frameSha256,
    inventorySha256: options.inventorySha256,
  });
  const workspaceRealPath = await realpath(dirname(options.descriptor.vaultPath));
  const reportRealPath = await realpath(options.descriptor.reportDirectory);
  if (!isPathInside(workspaceRealPath, reportRealPath)) {
    throw new Error("Installed crash report root escaped the real run workspace");
  }
  const path = crashRestorationBoundaryPath(reportRealPath, report.point, crashScenarioParts(report.scenario).kind, report.submissionKey);
  const temp = `${path}.${randomBytes(16).toString("hex")}.next`;
  await writeFile(temp, `${JSON.stringify(report)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try { await link(temp, path); }
  finally { await rm(temp, { force: true }); }
}

export async function loadCrashBoundaryReport(options: {
  readonly reportDirectory: string;
  readonly runId: string;
  readonly vaultId: string;
  readonly candidateBundleSha256: string;
  readonly installedMainSha256: string;
  readonly capabilityToken: string;
  readonly endpoint: string;
  readonly submissionKey: string;
  readonly crashPoint?: InstalledCrashPoint;
  readonly mutationKind?: InstalledCrashKind;
  readonly sequence?: number;
}): Promise<CrashRestorationBoundaryReport> {
  const report = crashRestorationBoundarySchema.parse(
    JSON.parse(await readFile(crashRestorationBoundaryPath(options.reportDirectory, options.crashPoint, options.mutationKind, options.submissionKey), "utf8")) as unknown,
  );
  if (report.scenario !== `${options.mutationKind ?? "create_note"}/${options.crashPoint ?? "after_prepared"}` || report.point !== (options.crashPoint ?? "after_prepared") || report.runId !== options.runId || report.vaultId !== options.vaultId ||
      report.candidateBundleSha256 !== options.candidateBundleSha256 ||
      report.installedMainSha256 !== options.installedMainSha256 ||
      report.capabilityToken !== options.capabilityToken ||
      report.endpoint !== options.endpoint || report.submissionKey !== options.submissionKey || report.sequence !== (options.sequence ?? 1)) {
    throw new Error("Installed crash boundary report is not bound to this run and candidate");
  }
  return report;
}

export async function crashPrivateResidue(vaultPath: string): Promise<{ stagingFiles: 0; trashFiles: 0 }> {
  const count = async (path: string): Promise<number> => {
    const facts = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (facts === null) return 0;
    if (facts.isSymbolicLink()) throw new Error("Installed crash private residue is unsafe");
    if (!facts.isDirectory()) return 1;
    let total = 0;
    for (const name of await readdir(path)) total += await count(join(path, name));
    return total;
  };
  if (await count(join(vaultPath, ".llm-wiki", "staging")) !== 0 || await count(join(vaultPath, ".llm-wiki", "trash")) !== 0) throw new Error("Installed crash terminal private residue remained");
  return { stagingFiles: 0, trashFiles: 0 };
}

export function crashOriginalInventory(current: readonly CrashInventoryEntry[], kind: InstalledCrashKind): CrashInventoryEntry[] {
  const profile = crashProfile(kind);
  const directories = kind === "create_note" ? ["Corpus", "Corpus/Notes"] : crashAttachmentDirectories(kind);
  const original = current.filter(entry => !profile.files.some(file => file.path === entry.path) && !directories.includes(entry.path));
  for (const fixture of profile.files) if (fixture.originalBytes !== null) original.push({ path: fixture.path, kind: "file", bytes: fixture.originalBytes.length, sha256: createHash("sha256").update(fixture.originalBytes).digest("hex") });
  return original.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

export async function parkInstalledCrashBoundary(options: {
  readonly descriptor: InstalledRuntimeAcceptanceDescriptor;
  readonly command: CrashRestorationCommand;
  readonly frame: unknown;
  readonly before: readonly CrashInventoryEntry[];
  readonly configDirectoryName?: string;
  readonly execution?: import("../change-set.js").ChangeSetCrashContext;
  readonly park?: () => Promise<void>;
}): Promise<void> {
  const { kind, point } = crashScenarioParts(options.command.scenario);
  validateInstalledCrashFixture(options.command);
  const phase = crashBoundaryPhase(point);
  if (phase === null && (options.execution?.vaultId !== options.command.expectedVaultId || !same(options.execution.input, options.command.input))) throw new Error("Unprepared installed crash marker targets another operation");
  const frame = options.frame as { phase?: string; vaultId?: string; input?: unknown } | null;
  if (phase === null ? frame !== null : frame?.phase !== phase || frame.vaultId !== options.command.expectedVaultId || !same(frame.input, options.command.input)) throw new Error("Installed crash injector did not observe the bound durable frame");
  const inventory = await crashInventory(options.descriptor.vaultPath, options.configDirectoryName);
  const original = point === "before_prepared" || point === "after_prepared" || point.startsWith("after_rollback") || point === "before_rolled_back" || point === "after_rolled_back" || point.startsWith("after_mutation:");
  verifyCrashInventory(options.before, inventory, kind, original ? "original" : "committed", point);
  await writeCrashRestorationBoundaryReport({ descriptor: options.descriptor, command: options.command, journalPhase: phase, frameSha256: frame === null ? null : crashDigest(frame), inventorySha256: crashDigest(inventory) });
  await (options.park?.() ?? new Promise<void>(() => undefined));
}

/** Read-only launch classification; no caller-provided skip-ready or trust bypass. */
export async function hasBoundInstalledCrashRecoveryPark(vaultPath: string, pluginId: string, configDirectoryName = ".obsidian"): Promise<boolean> {
  const loaded = await loadInstalledRuntimeAcceptanceDescriptor({ vaultPath, pluginId, configDirectoryName }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  const command = loaded === null ? null : parseCrashRestorationCommand(loaded.descriptor.command);
  if (loaded === null || command?.recovery === undefined) return false;
  const identity = JSON.parse(await readFile(join(vaultPath, configDirectoryName, "plugins", pluginId, "data.json"), "utf8")) as { vaultId: string; port: number };
  const handle = await open(join(vaultPath, ".llm-wiki", "recovery-journal.bin"), "r");
  let record;
  try { record = await (await openRecoveryJournal(handle)).recover(); } finally { await handle.close(); }
  const { kind, point } = crashScenarioParts(command.scenario);
  const marker = await loadCrashBoundaryReport({ ...loaded.descriptor, vaultId: identity.vaultId, endpoint: command.endpoint, submissionKey: command.submissionKey, mutationKind: kind, crashPoint: "after_snapshot", sequence: command.sequence - 1 });
  if (marker.frameSha256 !== command.recovery.frameSha256) throw new Error("Recovery-only launch lacks the previously supervised lead-in marker");
  const payload = record?.payload as { vaultId?: string; changeSetId?: string; input?: unknown } | undefined;
  if (record?.phase === "PREPARED" && payload?.vaultId === identity.vaultId && payload.changeSetId === command.recovery.changeSetId && same(payload.input, command.input) && command.endpoint === `http://127.0.0.1:${identity.port}/mcp`) {
    validateInstalledCrashFixture(command);
    // Recovery may already have progressed past its initial durable frame.
    // The immutable lead-in marker binds that initial frame; the runner still
    // requires the current selected marker + raw Journal before termination.
    return point.includes("rollback") || point.includes("rolled_back");
  }
  if (record?.phase === "ROLLED_BACK" && point === "after_rolled_back" && payload?.vaultId === identity.vaultId && payload.changeSetId === command.recovery.changeSetId && same(payload.input, command.input)) {
    const parked = await loadCrashBoundaryReport({ ...loaded.descriptor, vaultId: identity.vaultId, endpoint: command.endpoint, submissionKey: command.submissionKey, mutationKind: kind, crashPoint: point, sequence: command.sequence });
    if (parked.frameSha256 === crashDigest(record.payload)) return true;
  }
  throw new Error("Recovery-only launch no longer matches its bound recovery marker");
}

export function validateInstalledCrashRecovery(value: unknown, frame: unknown, identity: { vaultId: string; port: number } | null): CrashRestorationCommand {
  const command = crashRestorationCommandSchema.parse(value);
  const { kind, point } = crashScenarioParts(command.scenario);
  const observed = frame as { phase?: string; vaultId?: string; changeSetId?: string; input?: unknown } | null;
  if (command.recovery === undefined || !point.includes("rollback") && !point.includes("rolled_back") || observed?.phase !== "PREPARED" || identity === null || identity.vaultId !== command.expectedVaultId || command.endpoint !== `http://127.0.0.1:${identity.port}/mcp` || observed.vaultId !== identity.vaultId || observed.changeSetId !== command.recovery.changeSetId || crashDigest(frame) !== command.recovery.frameSha256 || !same(observed.input, command.input)) throw new Error("Installed recovery park is not bound to the interrupted PREPARED frame");
  validateInstalledCrashFixture(command);
  return command;
}
export function validateInstalledCrashFixture(command: CrashRestorationCommand): void {
  const { kind } = crashScenarioParts(command.scenario);
  if (!command.submissionKey.startsWith("submission-") || !same(command.input, crashProfile(kind).buildSubmitInput(command.submissionKey.slice("submission-".length)))) throw new Error("Installed crash fixture does not match the fixed mutation program");
}

export function parseCrashRestorationCommand(value: unknown): CrashRestorationCommand | null {
  const parsed = crashRestorationCommandSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function assertDescriptorSame(
  actual: InstalledRuntimeAcceptanceDescriptor,
  expected: InstalledRuntimeAcceptanceDescriptor,
): void {
  if (actual.runId !== expected.runId || actual.vaultPath !== expected.vaultPath ||
      actual.pluginId !== expected.pluginId ||
      actual.candidateBundleSha256 !== expected.candidateBundleSha256 ||
      actual.installedMainSha256 !== expected.installedMainSha256 ||
      actual.reportDirectory !== expected.reportDirectory ||
      actual.capabilityToken !== expected.capabilityToken) {
    throw new Error("Installed acceptance descriptor identity changed before command publication");
  }
}
