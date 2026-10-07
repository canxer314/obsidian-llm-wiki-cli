import { createHash } from "node:crypto";
import { appendFile, open, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { fifoCommandSchema, fifoEventSchema, type FifoEvent } from "./fifo-observation.js";
import { readPersistedBridgeIdentity } from "./obsidian-process.js";
import { isPathInside, loadInstalledRuntimeAcceptanceDescriptor, type InstalledRuntimeAcceptanceDescriptor } from "./acceptance-driver-protocol.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const fifoReportSchema = z.object({
  schemaVersion: z.literal(1), runId: z.string().min(1), vaultId: z.string().min(1), candidateBundleSha256: digest,
  installedMainSha256: digest, capabilityToken: digest, event: fifoEventSchema,
}).strict();
export const fifoReportPath = (descriptor: InstalledRuntimeAcceptanceDescriptor): string => join(descriptor.reportDirectory, "persistent-fifo-events.jsonl");

export async function appendFifoEvent(descriptor: InstalledRuntimeAcceptanceDescriptor, event: FifoEvent): Promise<void> {
  const command = fifoCommandSchema.parse(descriptor.command);
  const root = await realpath(descriptor.reportDirectory);
  const workspace = await realpath(join(descriptor.vaultPath, ".."));
  if (!isPathInside(workspace, root) || root === await realpath(descriptor.vaultPath)) throw new Error("FIFO report root escaped run workspace");
  const report = fifoReportSchema.parse({ schemaVersion: 1, runId: descriptor.runId, vaultId: command.expectedVaultId,
    candidateBundleSha256: descriptor.candidateBundleSha256, installedMainSha256: descriptor.installedMainSha256,
    capabilityToken: descriptor.capabilityToken, event });
  const path = fifoReportPath(descriptor);
  await appendFile(path, `${JSON.stringify(report)}\n`, { mode: 0o600 });
  const handle = await open(path, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
  if (event.kind === "committed" && event.submissionKey === command.keys[0]) {
    const marker = await open(join(root, "persistent-fifo-parked.json"), "wx", 0o600);
    try { await marker.writeFile(JSON.stringify(report)); await marker.sync(); } finally { await marker.close(); }
  }
}

export async function loadFifoEvents(descriptor: InstalledRuntimeAcceptanceDescriptor): Promise<FifoEvent[]> {
  const command = fifoCommandSchema.parse(descriptor.command);
  const raw = await readFile(fifoReportPath(descriptor), "utf8");
  if (!raw.endsWith("\n") || raw.length > 1_000_000) throw new Error("FIFO evidence is torn or oversized");
  return raw.trimEnd().split("\n").map(line => {
    const report = fifoReportSchema.parse(JSON.parse(line));
    if (report.runId !== descriptor.runId || report.vaultId !== command.expectedVaultId ||
        report.candidateBundleSha256 !== descriptor.candidateBundleSha256 || report.installedMainSha256 !== descriptor.installedMainSha256 ||
        report.capabilityToken !== descriptor.capabilityToken) throw new Error("FIFO report binding mismatch");
    return report.event;
  });
}

/** Created before Bridge startup so resumed queue observations cannot be lost. */
export async function createInstalledFifoObserver(options: { vaultPath: string; pluginId: string; configDirectoryName?: string }): Promise<((event: FifoEvent) => Promise<void>) | undefined> {
  if (!options.vaultPath.split(/[\\/]/u).at(-1)?.startsWith("installed-runtime-vault-")) return undefined;
  let loaded;
  try { loaded = await loadInstalledRuntimeAcceptanceDescriptor(options); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (loaded.descriptor.command.action !== "observe-persistent-fifo") return undefined;
  const descriptor = loaded.descriptor;
  const command = fifoCommandSchema.parse(descriptor.command);
  const reportRoot = await realpath(descriptor.reportDirectory);
  const endpoint = new URL(command.endpoint);
  if (new Set(command.keys).size !== 4 || endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.username || endpoint.password) throw new Error("FIFO observation command is not Vault-bound loopback");
  return async event => {
    if (!("submissionKey" in event) || !command.keys.includes(event.submissionKey)) return;
    const current = (await loadInstalledRuntimeAcceptanceDescriptor(options)).descriptor;
    if (JSON.stringify(current) !== JSON.stringify(descriptor) || await realpath(descriptor.reportDirectory) !== reportRoot) throw new Error("FIFO descriptor changed during observation");
    const identity = await readPersistedBridgeIdentity(options.vaultPath, options.pluginId, options.configDirectoryName);
    if (identity === null || identity.vaultId !== command.expectedVaultId || endpoint.toString() !== `http://127.0.0.1:${identity.port}/mcp`) throw new Error("FIFO observer belongs to a different Managed Vault");
    await appendFifoEvent(descriptor, event);
    // Only releases the fixed generated fixture's write lease. The Primary
    // Operator's pause and independent resume are never called by this observer.
    if (event.kind === "committed" && event.submissionKey === command.keys[0]) {
      if (command.holdUntil === undefined) await new Promise<void>(() => {});
      else {
        const path = join(reportRoot, "persistent-fifo-release.json");
        while (true) {
          let raw: string;
          try { raw = await readFile(path, "utf8"); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            await new Promise(resolve => setTimeout(resolve, 25));
            continue;
          }
          const facts = await stat(path);
          if (await realpath(path) !== path || !facts.isFile() || (process.platform !== "win32" && (facts.mode & 0o077) !== 0)) throw new Error("FIFO fixture release must be a private regular file");
          const release = z.object({ schemaVersion: z.literal(1), runId: z.string(), candidateBundleSha256: digest,
            installedMainSha256: digest, capabilityToken: digest, vaultId: z.string(), endpoint: z.string(),
            headChangeSetId: z.string(), pausingObserved: z.literal(true) }).strict().parse(JSON.parse(raw));
          if (release.runId !== descriptor.runId || release.candidateBundleSha256 !== descriptor.candidateBundleSha256 ||
              release.installedMainSha256 !== descriptor.installedMainSha256 || release.capabilityToken !== descriptor.capabilityToken ||
              release.vaultId !== command.expectedVaultId || release.endpoint !== command.endpoint || release.headChangeSetId !== event.changeSetId ||
              JSON.stringify((await loadInstalledRuntimeAcceptanceDescriptor(options)).descriptor) !== JSON.stringify(descriptor)) throw new Error("FIFO fixture release binding mismatch");
          return;
        }
      }
    }
  };
}

export const fifoDigest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
