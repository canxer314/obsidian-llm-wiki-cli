import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  App,
  CachedMetadata,
  EventRef,
  TAbstractFile,
  TFile,
} from "obsidian";

const PROBE_ID = "cache-causality-probe";
const SCRATCH_PREFIX = `__${PROBE_ID}__`;
const OUTPUT_ROOT = ".scratch/prototypes/cache-causality-probe/results";
const TIMEOUT_MS = 5_000;
const QUIET_MS = 250;

type EventKind = "vault-create" | "vault-modify" | "vault-rename" | "vault-delete" | "metadata-changed" | "metadata-resolve" | "metadata-resolved" | "sample";

type EvidenceEvent = {
  sequence: number;
  elapsedMs: number;
  kind: EventKind;
  path?: string;
  oldPath?: string;
  callbackContentVersion?: string;
  rereadContentVersion?: string;
  cachedContentVersion?: string;
  expectedContentVersion?: string;
  resolvedTargets?: string[];
  unresolvedTargets?: string[];
  note?: string;
};

type BarrierResult = {
  label: string;
  path: string;
  expectedContentVersion: string;
  ready: boolean;
  elapsedMs: number;
  timedOut: boolean;
  observations: number;
  cacheHasExpectedMarker: boolean;
  graphHasExpectedTarget: boolean;
  graphHasUnexpectedTarget: boolean;
};

type ScenarioResult = {
  name: string;
  passed: boolean;
  detail: string;
  barriers: BarrierResult[];
};

type ProbeReport = {
  probe: string;
  obsidianVersion: string;
  startedAt: string;
  completedAt: string;
  timeoutMs: number;
  quietMs: number;
  scenarios: ScenarioResult[];
  events: EvidenceEvent[];
  conclusions: {
    callbackDataIsVersionable: boolean;
    staleOrLateObservationsSeen: boolean;
    boundedBarrierSupported: boolean;
    renameNeedsTargetedProbe: boolean;
    supportableContract: string;
  };
};

class CacheCausalityProbe {
  private vaultRefs: EventRef[] = [];
  private metadataRefs: EventRef[] = [];
  private events: EvidenceEvent[] = [];
  private sequence = 0;
  private started = performance.now();
  private expectedByPath = new Map<string, string>();
  private cachedVersionByPath = new Map<string, string>();
  private outputDir = "";
  private scratchRoot = "";
  private createdScratch = false;

  constructor(
    private app: App,
    private TFileClass: typeof TFile,
    private obsidianVersion: string,
    private outputBase?: string,
  ) {}

  unload(): void {
    this.vaultRefs.forEach((ref) => this.app.vault.offref(ref));
    this.metadataRefs.forEach((ref) => this.app.metadataCache.offref(ref));
    this.vaultRefs = [];
    this.metadataRefs = [];
  }

  async run(): Promise<void> {
    this.started = performance.now();
    this.events = [];
    this.sequence = 0;
    this.expectedByPath.clear();
    this.cachedVersionByPath.clear();
    this.registerObservers();

    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    this.scratchRoot = `${SCRATCH_PREFIX}-${runId}`;
    this.createdScratch = false;
    const adapter = this.app.vault.adapter as typeof this.app.vault.adapter & { getBasePath(): string };
    this.outputDir = this.outputBase ? join(this.outputBase, runId) : join(adapter.getBasePath(), OUTPUT_ROOT, runId);
    await mkdir(this.outputDir, { recursive: true });

    const startedAt = new Date().toISOString();
    const scenarios: ScenarioResult[] = [];
    let thrown: unknown;
    try {
      await this.ensureCleanScratch();
      scenarios.push(await this.singleWriteScenario());
      scenarios.push(await this.rapidOverwriteScenario());
      scenarios.push(await this.renameTargetScenario());
      scenarios.push(await this.linkRepairScenario());
    } catch (error) {
      thrown = error;
      console.error(`[${PROBE_ID}] probe failed`, error);
    } finally {
      await this.removeScratch();
    }

    const callbackEvents = this.events.filter((event) => event.kind === "metadata-changed");
    const staleOrLate = callbackEvents.some(
      (event) =>
        event.callbackContentVersion !== undefined &&
        event.expectedContentVersion !== undefined &&
        event.callbackContentVersion !== event.expectedContentVersion,
    );
    const allBarriers = scenarios.flatMap((scenario) => scenario.barriers);
    const boundedBarrierSupported =
      thrown === undefined &&
      scenarios.every((scenario) => scenario.passed) &&
      allBarriers.every((barrier) => barrier.ready && !barrier.timedOut);
    const callbackDataIsVersionable = callbackEvents.length > 0 && callbackEvents.every((event) => event.callbackContentVersion !== undefined);

    const report: ProbeReport = {
      probe: PROBE_ID,
      obsidianVersion: this.obsidianVersion,
      startedAt,
      completedAt: new Date().toISOString(),
      timeoutMs: TIMEOUT_MS,
      quietMs: QUIET_MS,
      scenarios,
      events: this.events,
      conclusions: {
        callbackDataIsVersionable,
        staleOrLateObservationsSeen: staleOrLate,
        boundedBarrierSupported,
        renameNeedsTargetedProbe: true,
        supportableContract: boundedBarrierSupported
          ? "A bounded per-Change-Set barrier is supportable when every touched final Content Version is byte-verified, metadata-changed callback data is hashed and matched to that version, rename is correlated through Vault.rename, and resolvedLinks/unresolvedLinks are polled for the exact source/target postcondition. Timeout fails closed."
          : "Public observations do not support a causal metadata/link-graph success barrier for every tested mutation. Keep raw-byte read-after-success, publish bridge-owned snapshots, expose metadata/link readiness as bounded best-effort status, and fail closed or weaken semantic freshness on timeout.",
      },
    };

    await writeFile(join(this.outputDir, "events.jsonl"), this.events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
    await writeFile(join(this.outputDir, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
    await writeFile(join(this.outputDir, "verdict.md"), this.renderVerdict(report, thrown), "utf8");
    console.info(`[${PROBE_ID}] RESULT ${JSON.stringify({ outputDir: this.outputDir, conclusions: report.conclusions })}`);
    if (thrown !== undefined) throw thrown;
  }

  private registerObservers(): void {
    this.unload();
    this.vaultRefs = [
      this.app.vault.on("create", (file) => void this.captureVaultEvent("vault-create", file)),
      this.app.vault.on("modify", (file) => void this.captureVaultEvent("vault-modify", file)),
      this.app.vault.on("rename", (file, oldPath) => void this.captureVaultEvent("vault-rename", file, oldPath)),
      this.app.vault.on("delete", (file) => void this.captureVaultEvent("vault-delete", file)),
    ];
    this.metadataRefs = [
      this.app.metadataCache.on("changed", (file, data, cache) => void this.captureMetadataChanged(file, data, cache)),
      this.app.metadataCache.on("resolve", (file) => void this.captureResolve(file)),
      this.app.metadataCache.on("resolved", () => void this.captureResolved()),
    ];
  }

  private async singleWriteScenario(): Promise<ScenarioResult> {
    const target = await this.createMarkdown(`${this.scratchRoot}/single-target.md`, "# Single target\n");
    const sourceContent = "---\nprobe: single-v1\n---\n# Single source\n[[single-target]]\n";
    const source = await this.createMarkdown(`${this.scratchRoot}/single-source.md`, sourceContent);
    const barrier = await this.waitForBarrier("single-write", source, sourceContent, "single-target.md", undefined);
    return {
      name: "single-write",
      passed: barrier.ready,
      detail: "Create a source with frontmatter, heading, and resolved wikilink; require exact metadata marker and resolved target.",
      barriers: [barrier],
    };
  }

  private async rapidOverwriteScenario(): Promise<ScenarioResult> {
    const path = `${this.scratchRoot}/rapid-source.md`;
    const v1 = "---\nprobe: rapid-v1\n---\n# Rapid\n[[rapid-old-target]]\n";
    const v2 = "---\nprobe: rapid-v2\n---\n# Rapid\n[[rapid-final-target]]\n";
    await this.createMarkdown(`${this.scratchRoot}/rapid-old-target.md`, "# Old\n");
    await this.createMarkdown(`${this.scratchRoot}/rapid-final-target.md`, "# Final\n");
    const source = await this.createMarkdown(path, v1);
    const firstHash = sha256(v1);
    this.expectedByPath.set(path, firstHash);
    await this.app.vault.modify(source, v2);
    const barrier = await this.waitForBarrier("rapid-final", source, v2, "rapid-final-target.md", "rapid-old-target.md");
    return {
      name: "rapid-overwrite",
      passed: barrier.ready,
      detail: "Overwrite before waiting for v1 metadata; final success requires v2 metadata and graph, while any late v1 observation is ignored by Content Version.",
      barriers: [barrier],
    };
  }

  private async renameTargetScenario(): Promise<ScenarioResult> {
    const target = await this.createMarkdown(`${this.scratchRoot}/rename-before.md`, "# Rename target\n");
    const sourceContent = "---\nprobe: rename-source\n---\n# Rename source\n[[rename-before]]\n";
    const source = await this.createMarkdown(`${this.scratchRoot}/rename-source.md`, sourceContent);
    const before = await this.waitForBarrier("rename-before", source, sourceContent, "rename-before.md", undefined);
    await this.app.vault.rename(target, `${this.scratchRoot}/rename-after.md`);
    const rewrittenContent = sourceContent.replace("[[rename-before]]", "[[rename-after]]");
    await this.app.vault.modify(source, rewrittenContent);
    const after = await this.waitForBarrier("rename-after", source, rewrittenContent, "rename-after.md", "rename-before.md");
    const renameObserved = this.events.some(
      (event) => event.kind === "vault-rename" && event.oldPath === `${this.scratchRoot}/rename-before.md` && event.path === `${this.scratchRoot}/rename-after.md`,
    );
    return {
      name: "target-rename",
      passed: before.ready && after.ready && renameObserved,
      detail: "Rename a link target through Vault.rename, explicitly rewrite the source as a derived Change Set operation, then require the source graph to move to the final target without relying on metadata-changed for the renamed file.",
      barriers: [before, after],
    };
  }

  private async linkRepairScenario(): Promise<ScenarioResult> {
    const sourceContent = "---\nprobe: repair-source\n---\n# Repair source\n[[appears-later]]\n";
    const source = await this.createMarkdown(`${this.scratchRoot}/repair-source.md`, sourceContent);
    const unresolved = await this.waitForBarrier("repair-unresolved", source, sourceContent, undefined, undefined, "appears-later");
    await this.createMarkdown(`${this.scratchRoot}/appears-later.md`, "# Appears later\n");
    const resolved = await this.waitForBarrier("repair-resolved", source, sourceContent, "appears-later.md", undefined);
    return {
      name: "link-repair",
      passed: unresolved.ready && resolved.ready,
      detail: "Observe an unresolved link, then create its target and require the existing source graph to become resolved for the same source Content Version.",
      barriers: [unresolved, resolved],
    };
  }

  private async waitForBarrier(
    label: string,
    file: TFile,
    expectedContent: string,
    expectedResolvedBasename?: string,
    unexpectedResolvedBasename?: string,
    expectedUnresolved?: string,
  ): Promise<BarrierResult> {
    const barrierStarted = performance.now();
    const expectedContentVersion = sha256(expectedContent);
    this.expectedByPath.set(file.path, expectedContentVersion);
    const deadline = performance.now() + TIMEOUT_MS;
    let observations = 0;
    let lastSatisfiedAt: number | undefined;
    let state = await this.sample(file, expectedContentVersion, expectedResolvedBasename, unexpectedResolvedBasename, expectedUnresolved, label);

    while (performance.now() < deadline) {
      observations += 1;
      state = await this.sample(file, expectedContentVersion, expectedResolvedBasename, unexpectedResolvedBasename, expectedUnresolved, label);
      const satisfied = state.rawMatches && state.cacheMatches && state.graphExpected && !state.graphUnexpected;
      if (satisfied) {
        lastSatisfiedAt ??= performance.now();
        if (performance.now() - lastSatisfiedAt >= QUIET_MS) break;
      } else {
        lastSatisfiedAt = undefined;
      }
      await sleep(25);
    }

    const ready = state.rawMatches && state.cacheMatches && state.graphExpected && !state.graphUnexpected && lastSatisfiedAt !== undefined;
    return {
      label,
      path: file.path,
      expectedContentVersion,
      ready,
      elapsedMs: roundedElapsed(barrierStarted),
      timedOut: !ready,
      observations,
      cacheHasExpectedMarker: state.cacheMatches,
      graphHasExpectedTarget: state.graphExpected,
      graphHasUnexpectedTarget: state.graphUnexpected,
    };
  }

  private async sample(
    file: TFile,
    expectedContentVersion: string,
    expectedResolvedBasename?: string,
    unexpectedResolvedBasename?: string,
    expectedUnresolved?: string,
    label?: string,
  ): Promise<{ rawMatches: boolean; cacheMatches: boolean; graphExpected: boolean; graphUnexpected: boolean }> {
    const raw = await this.app.vault.read(file);
    const rawVersion = sha256(raw);
    const cachedVersion = this.cachedVersionByPath.get(file.path);
    const cache = this.app.metadataCache.getFileCache(file);
    const marker = cache?.frontmatter?.probe;
    const expectedMarker = extractProbeMarker(raw);
    const resolved = Object.keys(this.app.metadataCache.resolvedLinks[file.path] ?? {});
    const unresolved = Object.keys(this.app.metadataCache.unresolvedLinks[file.path] ?? {});
    const graphExpected = expectedResolvedBasename !== undefined
      ? resolved.some((path) => path.endsWith(`/${expectedResolvedBasename}`))
      : expectedUnresolved !== undefined
        ? unresolved.includes(expectedUnresolved)
        : true;
    const graphUnexpected = unexpectedResolvedBasename !== undefined && resolved.some((path) => path.endsWith(`/${unexpectedResolvedBasename}`));
    const cacheMatches = cachedVersion === expectedContentVersion && marker === expectedMarker;
    this.record({
      kind: "sample",
      path: file.path,
      rereadContentVersion: rawVersion,
      cachedContentVersion: cachedVersion,
      expectedContentVersion,
      resolvedTargets: resolved,
      unresolvedTargets: unresolved,
      note: `${label ?? "sample"}; marker=${String(marker)}; expectedMarker=${String(expectedMarker)}`,
    });
    return { rawMatches: rawVersion === expectedContentVersion, cacheMatches, graphExpected, graphUnexpected };
  }

  private async captureVaultEvent(kind: EventKind, file: TAbstractFile, oldPath?: string): Promise<void> {
    if (!file.path.startsWith(this.scratchRoot)) return;
    let rereadContentVersion: string | undefined;
    if (file instanceof this.TFileClass && file.extension === "md" && kind !== "vault-delete") {
      try {
        rereadContentVersion = sha256(await this.app.vault.read(file));
      } catch {
        rereadContentVersion = undefined;
      }
    }
    this.record({ kind, path: file.path, oldPath, rereadContentVersion, expectedContentVersion: this.expectedByPath.get(file.path) });
  }

  private async captureMetadataChanged(file: TFile, data: string, _cache: CachedMetadata): Promise<void> {
    if (!file.path.startsWith(this.scratchRoot)) return;
    const callbackContentVersion = sha256(data);
    this.cachedVersionByPath.set(file.path, callbackContentVersion);
    let rereadContentVersion: string | undefined;
    try {
      rereadContentVersion = sha256(await this.app.vault.read(file));
    } catch {
      rereadContentVersion = undefined;
    }
    this.record({
      kind: "metadata-changed",
      path: file.path,
      callbackContentVersion,
      rereadContentVersion,
      expectedContentVersion: this.expectedByPath.get(file.path),
      resolvedTargets: Object.keys(this.app.metadataCache.resolvedLinks[file.path] ?? {}),
      unresolvedTargets: Object.keys(this.app.metadataCache.unresolvedLinks[file.path] ?? {}),
    });
  }

  private async captureResolve(file: TFile): Promise<void> {
    if (!file.path.startsWith(this.scratchRoot)) return;
    let rereadContentVersion: string | undefined;
    try {
      rereadContentVersion = sha256(await this.app.vault.read(file));
    } catch {
      rereadContentVersion = undefined;
    }
    this.record({
      kind: "metadata-resolve",
      path: file.path,
      rereadContentVersion,
      expectedContentVersion: this.expectedByPath.get(file.path),
      resolvedTargets: Object.keys(this.app.metadataCache.resolvedLinks[file.path] ?? {}),
      unresolvedTargets: Object.keys(this.app.metadataCache.unresolvedLinks[file.path] ?? {}),
    });
  }

  private async captureResolved(): Promise<void> {
    this.record({ kind: "metadata-resolved", note: "global resolved event" });
  }

  private record(event: Omit<EvidenceEvent, "sequence" | "elapsedMs">): void {
    this.events.push({ sequence: ++this.sequence, elapsedMs: roundedElapsed(this.started), ...event });
  }

  private async createMarkdown(path: string, content: string): Promise<TFile> {
    const parent = dirname(path).replaceAll("\\", "/");
    if (parent && !this.app.vault.getAbstractFileByPath(parent)) await this.app.vault.createFolder(parent);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing) throw new Error(`Refusing to overwrite pre-existing path: ${path}`);
    this.expectedByPath.set(path, sha256(content));
    return this.app.vault.create(path, content);
  }

  private async ensureCleanScratch(): Promise<void> {
    if (!this.scratchRoot.startsWith(`${SCRATCH_PREFIX}-`)) throw new Error("Invalid scratch root");
    if (this.app.vault.getAbstractFileByPath(this.scratchRoot)) throw new Error(`Scratch root already exists: ${this.scratchRoot}`);
    await this.app.vault.createFolder(this.scratchRoot);
    this.createdScratch = true;
  }

  private async removeScratch(): Promise<void> {
    if (!this.createdScratch) return;
    if (!this.scratchRoot.startsWith(`${SCRATCH_PREFIX}-`)) throw new Error("Refusing to delete invalid scratch root");
    const scratch = this.app.vault.getAbstractFileByPath(this.scratchRoot);
    if (scratch) await this.app.vault.delete(scratch, true);
    this.createdScratch = false;
  }

  private renderVerdict(report: ProbeReport, thrown: unknown): string {
    const scenarioRows = report.scenarios
      .map((scenario) => `| ${scenario.name} | ${scenario.passed ? "PASS" : "FAIL"} | ${scenario.barriers.map((barrier) => `${barrier.label}: ${barrier.ready ? "ready" : "timeout"} @ ${barrier.elapsedMs} ms`).join("; ")} |`)
      .join("\n");
    return `# Installed cache and graph causality verdict\n\n` +
      `> PROTOTYPE ONLY — Obsidian ${report.obsidianVersion}, ThinkFlywheel Vault, ${report.startedAt}.\n\n` +
      `## Verdict\n\n${report.conclusions.supportableContract}\n\n` +
      `- MetadataCache changed callback data was hashable for every observation: **${report.conclusions.callbackDataIsVersionable}**\n` +
      `- Stale or late version observations occurred in this run: **${report.conclusions.staleOrLateObservationsSeen}**\n` +
      `- Bounded per-Change-Set success barrier supported by all scenarios: **${report.conclusions.boundedBarrierSupported}**\n` +
      `- Rename requires Vault.rename plus targeted graph probes: **${report.conclusions.renameNeedsTargetedProbe}**\n` +
      (thrown === undefined ? "" : `- Probe error: **${String(thrown)}**\n`) +
      `\n## Scenarios\n\n| Scenario | Result | Barrier observations |\n|---|---|---|\n${scenarioRows}\n\n` +
      `## Evidence\n\n- \`report.json\` contains the structured result.\n- \`events.jsonl\` contains the complete monotonic event/sample timeline with SHA-256 Content Versions.\n`;
  }
}

export async function runProbe(
  app: App,
  TFileClass: typeof TFile,
  obsidianVersion: string,
  outputBase?: string,
): Promise<void> {
  const probe = new CacheCausalityProbe(app, TFileClass, obsidianVersion, outputBase);
  try {
    await probe.run();
  } finally {
    probe.unload();
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}

function extractProbeMarker(content: string): string | undefined {
  return /^---\n[\s\S]*?^probe:\s*([^\n]+)$/m.exec(content)?.[1]?.trim();
}

function roundedElapsed(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
