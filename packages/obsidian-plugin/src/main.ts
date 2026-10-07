import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type App,
  FileSystemAdapter,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  Setting,
  TFile,
  getAllTags,
  getFrontMatterInfo,
  parseFrontMatterAliases,
  parseLinktext,
  parseYaml,
  resolveSubpath,
} from "obsidian";

import { createBridgeInstance } from "./bridge-instance.js";
import {
  hasContentInclusiveSelection,
  performContentInclusiveDiagnosticCopy,
} from "./content-inclusive-diagnostic-copy.js";
import { BRIDGE_STATE_DIRECTORY_NAME } from "./change-set.js";
import {
  EXACT_COMMITTED_BYTES,
  EXACT_ORIGINAL_BYTES,
  FRONTMATTER_COMMITTED_BYTES,
  FRONTMATTER_ORIGINAL_BYTES,
} from "./corpus/edit-fixtures.js";
import {
  TRASH_NOTE_PATH,
} from "./corpus/managed-trash-corpus.js";
import {
  MOVE_DERIVED_FIXTURES,
  MOVE_DESTINATION_PATH,
  MOVE_SOURCE_PATH,
} from "./corpus/move-note-corpus.js";
import { createFileSystemChangeSetDataSource } from "./file-system-change-set-data-source.js";
import {
  createChangeSetSemanticEvidenceTracker,
  createFileSystemChangeSetExecutionAdapter,
  createNodeFileSystemChangeSetHost,
} from "./file-system-change-set-execution.js";
import {
  assertValidatedInstalledBundle,
  registerRunMaintenanceCommand,
  type InstalledBundleProbe,
} from "./maintenance-operation.js";
import {
  ObsidianSemanticVersionTracker,
  createObsidianSearchDataSource,
  enumerateCanonicalReferenceTargets,
  isRegisteredSubpathResult,
} from "./obsidian-search-data-source.js";
import { RecoveryJournalIncompatibleError } from "./recovery-journal.js";
import {
  activateInstalledRuntimeAcceptanceDriver,
  type InstalledRuntimeAcceptanceActivation,
} from "./installed-runtime/acceptance-driver.js";
import {
  TRASH_REFERENCE_PATH,
  createInstalledSemanticEvidenceScenarioControl,
  createInstalledSemanticEvidenceWire,
} from "./installed-runtime/installed-semantic-evidence.js";
import { replaceExactCorpusProfile } from "./corpus/edit-body-corpus.js";
import { createNoteCorpusProfile } from "./corpus/create-note-corpus.js";
import { parseChangeSetSubmitInput } from "@llm-wiki/vault-contracts";
import {
  parseCrashRestorationCommand,
  writeCrashRestorationBoundaryReport,
} from "./installed-runtime/crash-restoration-protocol.js";
import {
  ManagedVaultBridgeRuntime,
  VaultPathChangeRequiredError,
  type PathChangeClassification,
} from "./managed-vault-runtime.js";

/**
 * Fresh local interactive Primary Operator confirmation for one
 * content-inclusive diagnostic generation (spec §9.4). Nothing is generated or
 * copied unless the Primary Operator explicitly chooses "Copy selection";
 * cancel, dismiss, or Escape resolves to `false`.
 */
class ContentInclusiveDiagnosticsConfirmationModal extends Modal {
  readonly #resolve: (confirmed: boolean) => void;

  constructor(app: App, resolve: (confirmed: boolean) => void) {
    super(app);
    this.#resolve = resolve;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", {
      text: "Copy selected content-inclusive diagnostics?",
    });
    contentEl.createEl("p", {
      text: "This copies only the explicitly selected Vault content in a separate content-inclusive diagnostic format.",
    });
    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText("Cancel")
          .onClick(() => {
            this.#resolve(false);
            this.close();
          }),
      )
      .addButton((button) =>
        button
          .setButtonText("Copy selection")
          .setCta()
          .onClick(() => {
            this.#resolve(true);
            this.close();
          }),
      );
  }

  override onClose(): void {
    this.#resolve(false);
    this.contentEl.empty();
  }
}

export default class VaultOperationBridgePlugin extends Plugin {
  #runtime: ManagedVaultBridgeRuntime | undefined;
  #installedRuntimeAcceptance: InstalledRuntimeAcceptanceActivation | undefined;

  override async onload(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const basePath =
      adapter instanceof FileSystemAdapter ? adapter.getBasePath() : this.app.vault.getName();
    const changeSetDataSource =
      adapter instanceof FileSystemAdapter
        ? createFileSystemChangeSetDataSource(basePath, adapter)
        : undefined;
    const stateDirectory = join(basePath, BRIDGE_STATE_DIRECTORY_NAME);
    const recoveryStatePath = join(stateDirectory, "bridge-state.json");
    const recoveryStateTemporaryPath = join(stateDirectory, "bridge-state.next");
    const recoveryJournalPath = join(stateDirectory, "recovery-journal.bin");
    const activateAcceptanceDriver = adapter instanceof FileSystemAdapter;
    let installedSemanticEvidence:
      | ReturnType<typeof createInstalledSemanticEvidenceScenarioControl>
      | undefined;
    let runtime!: ManagedVaultBridgeRuntime;
    let armedCrashBoundary: {
      readonly descriptor: import("./installed-runtime/acceptance-driver-protocol.js").InstalledRuntimeAcceptanceDescriptor;
      readonly command: import("./installed-runtime/crash-restoration-protocol.js").CrashRestorationCommand;
    } | undefined;
    let incompatibleState = false;
    const semanticVersions = new ObsidianSemanticVersionTracker();
    const referenced = async (path: string): Promise<boolean> =>
      Object.values(this.app.metadataCache.resolvedLinks).some(
        (targets) => targets[path] !== undefined,
      );
    let semanticEvidenceMode: "apply" | "restore" = "apply";
    const semanticEvidence = createChangeSetSemanticEvidenceTracker({
      publishSuccessorSearchSnapshot: async () => {
        await runtime.publishSuccessorSearchSnapshot();
        observeSnapshotPublication();
      },
      probes: {
        cacheVisible: async (path) => {
          const file = this.app.vault.getFileByPath(path);
          const cacheVisible = file !== null && this.app.metadataCache.getFileCache(file) !== null;
          installedSemanticEvidence?.recordTrashProbeObservation({
            path, cacheVisible, referenced: await referenced(path),
          });
          if (installedSemanticEvidence?.acceptsTrashProbeObservation(path, semanticEvidenceMode) === false) {
            return true;
          }
          return cacheVisible;
        },
        referenced: async (path) => {
          const actual = await referenced(path);
          if (semanticEvidenceMode === "restore" &&
              installedSemanticEvidence?.acceptsTrashProbeObservation(path, semanticEvidenceMode) === false) {
            const file = this.app.vault.getFileByPath(path);
            installedSemanticEvidence.recordTrashProbeObservation({
              path,
              cacheVisible: file !== null && this.app.metadataCache.getFileCache(file) !== null,
              referenced: false,
            });
            return false;
          }
          return actual;
        },
      },
    });
    const changeSetExecution =
      adapter instanceof FileSystemAdapter
        ? await createFileSystemChangeSetExecutionAdapter({
            journalPath: recoveryJournalPath,
            onRecoveryFramePersisted: (frame) => {
              installedSemanticEvidence?.recordRecoveryFrame(frame);
            },
            host: await createNodeFileSystemChangeSetHost({
              basePath,
              stateDirectory,
              moveFile: async (sourcePath, destinationPath) => {
                const source = this.app.vault.getFileByPath(sourcePath);
                if (source === null) throw new Error("Attachment move source disappeared");
                await this.app.vault.rename(source, destinationPath);
              },
              removeFile: async (path) => {
                const file = this.app.vault.getFileByPath(path);
                if (file === null) throw new Error("Attachment removal source disappeared");
                // Reached only from compare-before-restore rollback of
                // Change-Set-created copies. Permanent deletion is unavailable:
                // route through the system trash as a last-resort safety net.
                await this.app.vault.trash(file, true);
              },
              moveToTrash: async (path) => {
                const file = this.app.vault.getFileByPath(path);
                if (file === null) throw new Error("Managed trash source disappeared");
                // The host has already hard-linked the bytes into the
                // Bridge-owned managed trash before this call; use the system
                // trash rather than permanent deletion so the Bridge never
                // irreversibly destroys Vault content.
                await this.app.vault.trash(file, true);
              },
              restoreFromTrash: async (_trashId, path, bytes) => {
                const exactBytes = Uint8Array.from(bytes);
                await this.app.vault.createBinary(path, exactBytes.buffer);
              },
              referenced,
              beginSemanticEvidence: async (request) => {
                semanticEvidenceMode = request.mode;
                semanticEvidence.begin(request);
              },
              awaitSemanticEvidence: async (request) => {
                await semanticEvidence.await(request);
              },
              semanticEvidencePublishesSnapshot: true,
              publishSearchSnapshot: async (targets, moveBarrier) => {
                await runtime.publishSuccessorSearchSnapshot(targets, moveBarrier);
                observeSnapshotPublication();
              },
            }),
          }).catch((error: unknown) => {
            if (!(error instanceof RecoveryJournalIncompatibleError)) throw error;
            incompatibleState = true;
            return undefined;
          })
        : undefined;
    runtime = new ManagedVaultBridgeRuntime({
      vault: { name: this.app.vault.getName(), path: basePath },
      settings: {
        load: () => this.loadData() as Promise<unknown>,
        save: (settings) => this.saveData(settings),
        ...(adapter instanceof FileSystemAdapter
          ? {
              loadRecovery: async () => {
                try {
                  return JSON.parse(await readFile(recoveryStatePath, "utf8")) as unknown;
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
                  throw error;
                }
              },
              saveRecovery: async (settings: unknown) => {
                await mkdir(stateDirectory, { recursive: true });
                await writeFile(
                  recoveryStateTemporaryPath,
                  `${JSON.stringify(settings)}\n`,
                  "utf8",
                );
                await rename(recoveryStateTemporaryPath, recoveryStatePath);
              },
            }
          : {}),
      },
      searchDataSource: createObsidianSearchDataSource({
        markdownFiles: () => this.app.vault.getMarkdownFiles(),
        readBinary: async (path) => {
          const file = this.app.vault.getFileByPath(path);
          if (file === null) throw new Error("Search Snapshot file disappeared");
          return this.app.vault.readBinary(file);
        },
        fileCache: (path) => {
          const file = this.app.vault.getFileByPath(path);
          return file === null ? null : this.app.metadataCache.getFileCache(file);
        },
        semanticContentMatches: (path, bytes) =>
          installedSemanticEvidence?.acceptsMetadataCacheObservation(path) !== false &&
          semanticVersions.matches(path, bytes),
        resolveLink: (target, sourcePath) => {
          // Obsidian resolves decoded linkpaths, not raw destinations with fragments.
          const { path } = parseLinktext(target);
          return this.app.metadataCache.getFirstLinkpathDest(decodeURIComponent(path), sourcePath)?.path ?? null;
        },
        candidatePaths: (target, sourcePath) => {
          const { path } = parseLinktext(target);
          return enumerateCanonicalReferenceTargets(
            path,
            this.app.vault.getFiles().map((file) => ({
              path: file.path,
              basename: file.basename,
              aliases: parseFrontMatterAliases(
                this.app.metadataCache.getFileCache(file)?.frontmatter ?? null,
              ) ?? [],
            })),
            sourcePath,
          );
        },
        validSubpath: (target, resolvedPath) => {
          const { subpath } = parseLinktext(target);
          if (subpath === "") return true;
          const file = this.app.vault.getFileByPath(resolvedPath);
          const cache = file === null ? null : this.app.metadataCache.getFileCache(file);
          if (cache === null) return false;
          const resolved = resolveSubpath(cache, subpath);
          if (resolved === null) return false;
          const installed = resolved.type === "heading"
            ? { type: "heading" as const, heading: resolved.current.heading }
            : resolved.type === "block"
              ? { type: "block" as const, id: resolved.block.id }
              : { type: "footnote" as const };
          return isRegisteredSubpathResult(
            subpath,
            installed,
            cache.headings?.map(({ heading }) => heading) ?? [],
          );
        },
        resolvedLinks: () => this.app.metadataCache.resolvedLinks,
        unresolvedLinks: () => this.app.metadataCache.unresolvedLinks,
        parseFrontmatter: (frontmatter) => {
          const clone = structuredClone(frontmatter);
          delete clone.position;
          return clone;
        },
        allTags: (path) => {
          const file = this.app.vault.getFileByPath(path);
          const cache = file === null ? null : this.app.metadataCache.getFileCache(file);
          return cache === null ? null : getAllTags(cache);
        },
      }),
      readDataSource: {
        readBinary: async (path) =>
          (await adapter.exists(path)) ? adapter.readBinary(path) : null,
        parseFrontmatter: (content) => {
          const { exists, frontmatter } = getFrontMatterInfo(content);
          if (!exists) return null;
          const parsed: unknown = parseYaml(frontmatter);
          return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
        },
        headings: (path) => {
          const file = this.app.vault.getFileByPath(path);
          const headings = file === null ? null : this.app.metadataCache.getFileCache(file)?.headings;
          return headings?.map(({ heading, level, position }) => ({
            heading,
            level,
            startOffset: position.start.offset,
            endOffset: position.end.offset,
          })) ?? null;
        },
      },
      changeSetDataSource,
      changeSetExecution,
      crashInjector: async (point) => {
        const armed = armedCrashBoundary;
        if (armed === undefined || !armed.command.scenario.endsWith(`/${point}`)) return;
        const expectedPhase = point === "after_prepared" ? "PREPARED" : "COMMITTED";
        const frame = await changeSetExecution?.loadRecoveryFrame();
        if (frame?.phase !== expectedPhase || frame.vaultId !== armed.command.expectedVaultId ||
            JSON.stringify(frame.input) !== JSON.stringify(armed.command.input)) {
          throw new Error("Installed crash injector did not observe the armed durable frame");
        }
        await writeCrashRestorationBoundaryReport({ descriptor: armed.descriptor,
          command: armed.command, journalPhase: frame.phase });
        await new Promise<void>(() => undefined);
      },
      incompatibleState,
      onSearchSnapshotRefreshScheduled: (observation) => {
        installedSemanticEvidence?.recordSearchSnapshotRefresh(observation);
      },
      onSuccessBarrierRound: (observation) => {
        installedSemanticEvidence?.recordSearchSnapshotBarrierRound(observation);
      },
      createBridge: createBridgeInstance,
    });
    this.#runtime = runtime;
    const observeSnapshotPublication = (): void => {
      const snapshot = runtime.currentSearchSnapshotObservation;
      if (snapshot !== null) {
        installedSemanticEvidence?.recordSearchSnapshotPublication(snapshot);
      }
    };
    const scheduleRefresh = (): void => {
      runtime.scheduleSearchSnapshotRefresh();
    };
    const scheduleMarkdownRefresh = (file: unknown): void => {
      if (file instanceof TFile && file.extension === "md") scheduleRefresh();
    };
    this.registerEvent(
      this.app.metadataCache.on("changed", (file, data) => {
        if (file instanceof TFile && file.extension === "md") {
          const observation = {
            path: file.path,
            contentVersion:
              `sha256:${createHash("sha256").update(data, "utf8").digest("hex")}`,
            bomPrefixedContentVersion:
              `sha256:${createHash("sha256").update(Buffer.from([0xef, 0xbb, 0xbf])).update(data, "utf8").digest("hex")}`,
          };
          if (
            installedSemanticEvidence?.acceptMetadataCacheObservation(observation) !== false
          ) {
            semanticVersions.observe(file.path, data);
            installedSemanticEvidence?.recordMetadataCacheObservation(observation);
          }
          scheduleRefresh();
        }
      }),
    );
    this.registerEvent(this.app.metadataCache.on("resolve", scheduleMarkdownRefresh));
    this.registerEvent(this.app.metadataCache.on("resolved", scheduleRefresh));
    this.registerEvent(this.app.vault.on("create", (file) => {
      semanticEvidence.record({ kind: "create", path: file.path });
      installedSemanticEvidence?.recordVaultEvent({
        kind: "create",
        path: file.path,
      });
      scheduleMarkdownRefresh(file);
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      installedSemanticEvidence?.recordVaultEvent({
        kind: "create",
        path: file.path,
      });
      scheduleMarkdownRefresh(file);
    }));
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        semanticEvidence.record({ kind: "delete", path: file.path });
        installedSemanticEvidence?.recordVaultEvent({
          kind: "delete",
          path: file.path,
        });
        if (file instanceof TFile && file.extension === "md") {
          semanticVersions.remove(file.path);
          scheduleRefresh();
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        const renameEvent = { kind: "rename" as const, oldPath, path: file.path };
        if (installedSemanticEvidence?.recordVaultEvent(renameEvent) !== false) {
          semanticEvidence.record(renameEvent);
        }
        if (file instanceof TFile && file.extension === "md") {
          if (installedSemanticEvidence?.acceptsMetadataCacheObservation(file.path) !== false) {
            semanticVersions.rename(oldPath, file.path);
          }
          scheduleRefresh();
        } else if (oldPath.endsWith(".md")) {
          scheduleRefresh();
        }
      }),
    );

    try {
      await runtime.load();
    } catch (error) {
      if (!(error instanceof VaultPathChangeRequiredError)) throw error;
    }
    if (
      activateAcceptanceDriver &&
      changeSetExecution !== undefined &&
      runtime.bridge !== undefined
    ) {
      const installedSemanticEvidenceWire = createInstalledSemanticEvidenceWire();
      installedSemanticEvidence = createInstalledSemanticEvidenceScenarioControl({
        vaultPath: basePath,
        wire: installedSemanticEvidenceWire,
        observeHealth: (observation) =>
          installedSemanticEvidenceWire.health(observation),
        currentSnapshot: () => runtime.currentSearchSnapshotObservation,
        loadRecoveryFrame: () => changeSetExecution.loadRecoveryFrame(),
        induceQuietWindowResets: async () => {
          const file = this.app.vault.getFileByPath("Corpus/Notes/Alpha.md");
          if (file === null) {
            throw new Error("Installed quiet-window reset fixture is unavailable");
          }
          const bytes = await this.app.vault.readBinary(file);
          await this.app.vault.modifyBinary(file, bytes);
          await this.app.vault.modifyBinary(file, bytes);
        },
        induceStaleObservationsThenFresh: async () => {
          const file = this.app.vault.getFileByPath("Corpus/Notes/Alpha.md");
          if (file === null) {
            throw new Error("Installed stale-observation fixture is unavailable");
          }
          await this.app.vault.modify(file, "# Foreign cache observation 你好 🚀\n");
          await installedSemanticEvidence!.waitForMetadataContentVersion(
            "sha256:7a30e1be393dd458c316cf18312475986671d3d89199480f7f00143d5a385b4f",
          );
          await installedSemanticEvidence!.waitForRejectedSnapshotRounds(1);
          semanticVersions.remove(file.path);
          installedSemanticEvidence!.markMetadataContentVersionMissing();
          runtime.scheduleSearchSnapshotRefresh();
          await installedSemanticEvidence!.waitForRejectedSnapshotRounds(2);
          await this.app.vault.modify(file, "# Corpus Alpha\n\n你好，世界 🚀\ncreated by the crash corpus\n");
          await installedSemanticEvidence!.waitForMetadataContentVersion(
            "sha256:a36f88ca2067ed0fd114674d7d142a15a4575b837b1bdd0155daa26e7a5ea3df",
          );
        },
        induceStaleObservationDeadline: async () => {
          const file = this.app.vault.getFileByPath("Corpus/Notes/Alpha.md");
          if (file === null) {
            throw new Error("Installed stale-observation fixture is unavailable");
          }
          await this.app.vault.modify(file, "# Foreign cache observation 你好 🚀\n");
          await installedSemanticEvidence!.waitForMetadataContentVersion(
            "sha256:7a30e1be393dd458c316cf18312475986671d3d89199480f7f00143d5a385b4f",
          );
          await writeFile(
            join(basePath, ...file.path.split("/")),
            "# Corpus Alpha\n\n你好，世界 🚀\ncreated by the crash corpus\n",
            "utf8",
          );
          runtime.scheduleSearchSnapshotRefresh();
          await installedSemanticEvidence!.waitForRejectedSnapshotRounds(1);
        },
        induceEditBodyStaleThenFresh: async ({
          committedContentVersion,
          waitForCommittedMetadataContentVersion,
        }) => {
          const file = this.app.vault.getFileByPath("Corpus/Edits/Exact.md");
          if (file === null) {
            throw new Error("Installed edit-body fixture is unavailable");
          }
          await installedSemanticEvidence!.waitForRejectedSnapshotRounds(1);
          installedSemanticEvidence!.releaseCommittedMetadataObservation();
          const committed = await this.app.vault.readBinary(file);
          const observedCommittedContentVersion =
            `sha256:${createHash("sha256").update(Buffer.from(committed)).digest("hex")}`;
          if (observedCommittedContentVersion !== committedContentVersion) {
            throw new Error("Installed edit-body bytes do not match the committed Content Version");
          }
          await this.app.vault.modifyBinary(file, committed);
          await waitForCommittedMetadataContentVersion();
        },
        induceEditBodyMissingObservationDeadline: async () => {
          const file = this.app.vault.getFileByPath("Corpus/Edits/Exact.md");
          if (file === null) {
            throw new Error("Installed edit-body fixture is unavailable");
          }
          semanticVersions.remove(file.path);
          installedSemanticEvidence!.markMetadataContentVersionMissing();
          runtime.scheduleSearchSnapshotRefresh();
          await installedSemanticEvidence!.waitForRejectedSnapshotRounds(1);
        },
        induceEditBodyQuietWindowContradiction: async () => {
          const file = this.app.vault.getFileByPath("Corpus/Edits/Exact.md");
          if (file === null) {
            throw new Error("Installed edit-body fixture is unavailable");
          }
          await installedSemanticEvidence!.waitForRejectedSnapshotRounds(1);
          installedSemanticEvidence!.releaseCommittedMetadataObservation();
          await this.app.vault.modifyBinary(file, await this.app.vault.readBinary(file));
          await installedSemanticEvidence!.waitForMetadataContentVersion(
            "sha256:657e5a4753c47b54776381b314eaeb783775235960c1b79c1970311652683cb2",
          );
        },
        induceEditBodyContraryThirdParty: async () => {
          const file = this.app.vault.getFileByPath("Corpus/Edits/Exact.md");
          if (file === null) {
            throw new Error("Installed edit-body fixture is unavailable");
          }
          semanticVersions.remove(file.path);
          installedSemanticEvidence!.markMetadataContentVersionMissing();
          runtime.scheduleSearchSnapshotRefresh();
          await installedSemanticEvidence!.waitForRejectedSnapshotRounds(1);
          await writeFile(
            join(basePath, ...file.path.split("/")),
            "# Third-party interference\n\nForeign 你好 🚀\n",
            "utf8",
          );
        },
        induceMultiFrontmatterReorderedCallbacks: async () => {
          const cPath = "Corpus/Multi/NoteC.md";
          const dPath = "Corpus/Multi/NoteD.md";
          const c = this.app.vault.getFileByPath(cPath);
          const d = this.app.vault.getFileByPath(dPath);
          if (c === null || d === null) {
            throw new Error("Installed multi-frontmatter fixtures are unavailable");
          }
          const cOriginal = Uint8Array.from(EXACT_ORIGINAL_BYTES);
          const dOriginal = Uint8Array.from(FRONTMATTER_ORIGINAL_BYTES);
          const cCommitted = Uint8Array.from(EXACT_COMMITTED_BYTES);
          const dCommitted = Uint8Array.from(FRONTMATTER_COMMITTED_BYTES);
          const cCommittedVersion =
            `sha256:${createHash("sha256").update(cCommitted).digest("hex")}`;
          const dCommittedVersion =
            `sha256:${createHash("sha256").update(dCommitted).digest("hex")}`;

          installedSemanticEvidence!.releaseCommittedMetadataObservation(cPath);
          await this.app.vault.modifyBinary(c, cCommitted.buffer);
          await installedSemanticEvidence!.waitForMetadataContentVersion(cCommittedVersion);
          await this.app.vault.modifyBinary(d, dOriginal.buffer);
          await installedSemanticEvidence!.waitForRejectedSnapshotRounds(1);

          await this.app.vault.modifyBinary(c, cOriginal.buffer);
          installedSemanticEvidence!.releaseCommittedMetadataObservation(dPath);
          await this.app.vault.modifyBinary(d, dCommitted.buffer);
          await installedSemanticEvidence!.waitForMetadataContentVersion(dCommittedVersion);
          await installedSemanticEvidence!.waitForRejectedSnapshotRounds(2);

          await this.app.vault.modifyBinary(c, cCommitted.buffer);
          await installedSemanticEvidence!.waitForMetadataContentVersion(cCommittedVersion);
        },
        induceMoveDelayedRename: async () => {
          await installedSemanticEvidence!.waitForRenameObservation();
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
          const renameEvent = installedSemanticEvidence!.releaseDelayedRenameEvent();
          if (renameEvent !== null) semanticEvidence.record(renameEvent);
          runtime.scheduleSearchSnapshotRefresh();
        },
        induceMoveStalePreBeginCallback: async () => {
          installedSemanticEvidence!.recordVaultEvent({
            kind: "rename",
            oldPath: MOVE_SOURCE_PATH,
            path: MOVE_DESTINATION_PATH,
          });
        },
        induceMoveStaleAndWrongPathCallbacks: async () => {
          installedSemanticEvidence!.recordVaultEvent({
            kind: "rename",
            oldPath: "Corpus/Move/Wrong.md",
            path: MOVE_DESTINATION_PATH,
          });
          await installedSemanticEvidence!.waitForRenameObservation();
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
          const renameEvent = installedSemanticEvidence!.releaseDelayedRenameEvent();
          if (renameEvent !== null) semanticEvidence.record(renameEvent);
          runtime.scheduleSearchSnapshotRefresh();
        },
        induceMoveGraphMismatchThenConverged: async () => {
          await installedSemanticEvidence!.waitForRenameObservation();
          const renameEvent = installedSemanticEvidence!.releaseDelayedRenameEvent();
          if (renameEvent !== null) semanticEvidence.record(renameEvent);
          const closure = MOVE_DERIVED_FIXTURES[0];
          if (closure === undefined) {
            throw new Error("Installed move closure fixture is unavailable");
          }
          const resolvedLinks = this.app.metadataCache.resolvedLinks[closure.path];
          if (resolvedLinks === undefined) {
            throw new Error("Installed move closure graph is unavailable");
          }
          const convergedGraph = { ...resolvedLinks };
          for (const path of Object.keys(resolvedLinks)) delete resolvedLinks[path];
          resolvedLinks[MOVE_SOURCE_PATH] = 1;
          try {
            runtime.scheduleSearchSnapshotRefresh();
            await installedSemanticEvidence!.waitForRejectedSnapshotRounds(1);
          } finally {
            for (const path of Object.keys(resolvedLinks)) delete resolvedLinks[path];
            Object.assign(resolvedLinks, convergedGraph);
            runtime.scheduleSearchSnapshotRefresh();
          }
        },
        induceMoveStaleClosureObservation: async () => {
          await installedSemanticEvidence!.waitForRenameObservation();
          const renameEvent = installedSemanticEvidence!.releaseDelayedRenameEvent();
          if (renameEvent !== null) semanticEvidence.record(renameEvent);
          const closure = MOVE_DERIVED_FIXTURES[1];
          if (closure === undefined) {
            throw new Error("Installed move closure fixture is unavailable");
          }
          const file = this.app.vault.getFileByPath(closure.path);
          if (file === null) {
            throw new Error("Installed move closure note is unavailable");
          }
          await installedSemanticEvidence!.waitForRejectedSnapshotRounds(1);
          installedSemanticEvidence!.releaseCommittedMetadataObservation(closure.path);
          await this.app.vault.modifyBinary(
            file,
            Uint8Array.from(closure.committedBytes).buffer,
          );
        },
        induceMoveGraphMismatchDeadline: async () => {
          await installedSemanticEvidence!.waitForRenameObservation();
          const renameEvent = installedSemanticEvidence!.releaseDelayedRenameEvent();
          if (renameEvent !== null) semanticEvidence.record(renameEvent);
          const closure = MOVE_DERIVED_FIXTURES[0];
          if (closure === undefined) {
            throw new Error("Installed move closure fixture is unavailable");
          }
          const resolvedLinks = this.app.metadataCache.resolvedLinks[closure.path];
          if (resolvedLinks === undefined) {
            throw new Error("Installed move closure graph is unavailable");
          }
          for (const path of Object.keys(resolvedLinks)) delete resolvedLinks[path];
          resolvedLinks[MOVE_SOURCE_PATH] = 1;
          runtime.scheduleSearchSnapshotRefresh();
          await installedSemanticEvidence!.waitForRejectedSnapshotRounds(1);
        },
        induceTrashDelayedProbes: async () => {
          const observe = (): void => {
            const file = this.app.vault.getFileByPath(TRASH_NOTE_PATH);
            installedSemanticEvidence!.recordTrashProbeObservation({
              path: TRASH_NOTE_PATH,
              cacheVisible:
                file !== null && this.app.metadataCache.getFileCache(file) !== null,
              referenced: Object.values(this.app.metadataCache.resolvedLinks).some(
                (targets) => targets[TRASH_NOTE_PATH] !== undefined,
              ),
            });
          };
          observe();
          while (true) {
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
            observe();
            const file = this.app.vault.getFileByPath(TRASH_NOTE_PATH);
            const cacheVisible =
              file !== null && this.app.metadataCache.getFileCache(file) !== null;
            const isReferenced = Object.values(
              this.app.metadataCache.resolvedLinks,
            ).some((targets) => targets[TRASH_NOTE_PATH] !== undefined);
            if (!cacheVisible && !isReferenced) break;
          }
        },
        induceTrashProbeDeadlineThenRestored: async () => {
          const deadline = Date.now() + 5_000;
          while (semanticEvidenceMode !== "restore") {
            if (Date.now() > deadline + 1_000) {
              throw new Error("Installed trash apply did not reach restoration");
            }
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
          }
        },
        induceTrashRestoreEvidenceDeadline: async () => {
          const deadline = Date.now() + 15_000;
          while ((await changeSetExecution?.loadRecoveryFrame())?.phase !== "FAILED") {
            if (Date.now() >= deadline) {
              throw new Error("Installed trash restoration did not fail closed");
            }
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
          }
        },
        observeTrashProbes: async (path) => {
          const file = this.app.vault.getFileByPath(path);
          return {
            cacheVisible: file !== null && this.app.metadataCache.getFileCache(file) !== null,
            referenced: await referenced(path),
          };
        },
        induceTrashContraryThirdParty: async () => {
          const deadline = Date.now() + 5_000;
          while (this.app.vault.getFileByPath(TRASH_NOTE_PATH) !== null) {
            if (Date.now() >= deadline) {
              throw new Error("Installed trash mutation did not hide its public path");
            }
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
          }
          const reference = this.app.vault.getFileByPath(TRASH_REFERENCE_PATH);
          if (reference === null) {
            throw new Error("Installed trash reference fixture is unavailable");
          }
          await this.app.vault.modifyBinary(
            reference,
            new TextEncoder().encode("# Trash reference\n\n").buffer,
          );
          await writeFile(
            join(basePath, ...TRASH_NOTE_PATH.split("/")),
            "# Third-party interference\n\nForeign 你好 🚀\n",
            "utf8",
          );
        },
        seedPath: async (path, bytes) => {
          if (this.app.vault.getAbstractFileByPath(path) !== null) {
            throw new Error("Installed edit-body fixture path is not clean");
          }
          const segments = path.split("/");
          for (let length = 1; length < segments.length; length += 1) {
            const parent = segments.slice(0, length).join("/");
            if (this.app.vault.getAbstractFileByPath(parent) === null) {
              await this.app.vault.createFolder(parent);
            }
          }
          await this.app.vault.createBinary(path, Uint8Array.from(bytes).buffer);
          const file = this.app.vault.getFileByPath(path);
          if (file === null) {
            throw new Error("Installed edit-body fixture seeding failed");
          }
          const deadline = Date.now() + 5_000;
          while (!semanticVersions.matches(path, bytes)) {
            if (Date.now() >= deadline) {
              throw new Error("Installed fixture seed metadata did not match its bytes");
            }
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
          }
        },
        refreshSeedFixtures: async () => {
          const baselineVersion = runtime.currentSearchSnapshotObservation?.version ?? 0;
          runtime.scheduleSearchSnapshotRefresh();
          await runtime.refreshSearchSnapshot();
          const deadline = Date.now() + 5_000;
          while (true) {
            const snapshot = runtime.currentSearchSnapshotObservation;
            if (snapshot !== null && snapshot.version > baselineVersion) return snapshot;
            if (Date.now() >= deadline) {
              throw new Error("Installed mutation fixture Search Snapshot is unavailable");
            }
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
          }
        },
        cleanupPath: async (path) => {
          const file = this.app.vault.getFileByPath(path);
          if (file !== null) {
            try {
              await this.app.vault.delete(file, true);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT" || await adapter.exists(path)) {
                throw error;
              }
            }
          }
        },
        refreshAfterCleanup: async () => {
          runtime.scheduleSearchSnapshotRefresh();
          await runtime.refreshSearchSnapshot();
        },
      });
      this.#installedRuntimeAcceptance =
        (await activateInstalledRuntimeAcceptanceDriver({
          vaultPath: basePath,
          pluginId: this.manifest.id,
          configDirectoryName: this.app.vault.configDir,
          executeSemanticEvidenceScenario: (request) =>
            installedSemanticEvidence!.execute(request),
          executeCrashRestorationScenario: async ({ descriptor, command }) => {
            const parsed = parseCrashRestorationCommand(command);
            if (parsed === null) throw new Error("Installed crash-restoration command is malformed");
            if (parsed.expectedVaultId !== runtime.persistedSettings?.vaultId ||
                parsed.endpoint !== runtime.bridge?.endpoint.toString()) {
              throw new Error("Installed crash-restoration command targets another runtime");
            }
            const profile = parsed.scenario.startsWith("edit_body/") ? replaceExactCorpusProfile() : createNoteCorpusProfile();
            if (!parsed.submissionKey.startsWith("submission-")) {
              throw new Error("Installed crash-restoration fixture key is invalid");
            }
            const expectedInput = profile.buildSubmitInput(parsed.submissionKey.slice("submission-".length));
            if (JSON.stringify(parsed.input) !== JSON.stringify(expectedInput)) {
              throw new Error("Installed crash-restoration fixture does not match the selected mutation program");
            }
            if (armedCrashBoundary !== undefined) throw new Error("Crash slice is already armed");
            const before = await changeSetExecution.loadRecoveryFrame();
            if (before !== null) throw new Error("Crash slice requires a clean Recovery Journal");
            const input = parseChangeSetSubmitInput(parsed.input);
            if (parsed.scenario.startsWith("edit_body/")) {
              const fixture = profile.files[0]!;
              const bytes = await readFile(join(basePath, ...fixture.path.split("/")));
              if (!bytes.equals(fixture.originalBytes!)) throw new Error("Installed edit-body seed bytes changed");
              const file = this.app.vault.getFileByPath(fixture.path);
              if (file === null) throw new Error("Installed edit-body seed is not visible to Obsidian");
              // A cold-cache startup may have indexed the pre-seeded note before
              // this plugin subscribed. Re-publish identical bytes through the
              // real Vault API; only its metadata callback may satisfy matches.
              await this.app.vault.modifyBinary(file, Uint8Array.from(bytes).buffer);
              const deadline = Date.now() + 5_000;
              while (!semanticVersions.matches(fixture.path, fixture.originalBytes!)) {
                if (Date.now() >= deadline) throw new Error("Installed edit-body seed metadata is unavailable");
                await new Promise(resolve => setTimeout(resolve, 10));
              }
              runtime.scheduleSearchSnapshotRefresh();
              await runtime.refreshSearchSnapshot();
            }
            armedCrashBoundary = { descriptor, command: parsed };
            void installedSemanticEvidenceWire.submit({ endpoint: new URL(parsed.endpoint),
              expectedVaultId: parsed.expectedVaultId, input })
              .finally(() => { armedCrashBoundary = undefined; })
              .catch(() => undefined);
            return parsed.scenario.endsWith("/after_prepared")
              ? { boundary: "after_prepared", journalPhase: "PREPARED" }
              : { boundary: "after_committed", journalPhase: "COMMITTED" };
          },
        })) ?? undefined;
    }
    const addPathClassificationCommand = (
      classification: PathChangeClassification,
      label: string,
    ): void => {
      this.addCommand({
        id: `classify-vault-path-change-as-${classification}`,
        name: `Classify Vault path change as ${label}`,
        checkCallback: (checking) => {
          if (runtime.pendingPathChange === undefined) return false;
          if (!checking) {
            void runtime
              .classifyPathChange(classification)
              .then(() => runtime.load());
          }
          return true;
        },
      });
    };
    addPathClassificationCommand("move", "move");
    addPathClassificationCommand("copy", "copy");
    const observeLocalWriteControl = async (
      action: "pause-writes" | "accept-recovery-baseline" | "resume-writes",
      operation: () => Promise<void>,
    ): Promise<void> => {
      const acceptance = this.#installedRuntimeAcceptance;
      if (acceptance === undefined) return operation();
      const settings = runtime.persistedSettings;
      const bridge = runtime.bridge;
      if (settings === undefined || bridge === undefined) return operation();
      const invocationId = randomUUID();
      const before = await runtime.createStandardDiagnosticBundle();
      let outcome: "accepted" | "rejected" = "accepted";
      let rejected = false;
      let failure: unknown;
      try {
        await operation();
      } catch (error) {
        outcome = "rejected";
        rejected = true;
        failure = error;
      }
      const after = await runtime.createStandardDiagnosticBundle();
      await acceptance.recordLocalWriteControl({
        vaultId: settings.vaultId, endpoint: bridge.endpoint, invocationId, action, outcome, before, after,
      });
      if (rejected) throw failure;
    };
    this.addCommand({
      id: "pause-managed-vault-writes",
      name: "Pause Managed Vault writes",
      callback: () => observeLocalWriteControl("pause-writes", () => runtime.pauseWrites()),
    });
    this.addCommand({
      id: "accept-trusted-managed-vault-recovery-baseline",
      name: "Accept trusted Managed Vault recovery baseline",
      callback: () => observeLocalWriteControl("accept-recovery-baseline", () => runtime.acceptTrustedRecoveryBaseline()),
    });
    this.addCommand({
      id: "resume-managed-vault-writes",
      name: "Resume Managed Vault writes",
      callback: () => observeLocalWriteControl("resume-writes", () => runtime.resumeWrites()),
    });
    const pluginDirectory =
      this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const bundleProbe: InstalledBundleProbe | undefined =
      adapter instanceof FileSystemAdapter
        ? {
            readManifest: async () =>
              JSON.parse(await adapter.read(`${pluginDirectory}/manifest.json`)) as unknown,
            hasEntryPoint: () => adapter.exists(`${pluginDirectory}/main.js`),
          }
        : undefined;
    registerRunMaintenanceCommand(this, async () => {
      if (bundleProbe === undefined) {
        throw new Error("Validated bundle probing requires a file-system Vault adapter");
      }
      await runtime.runOperatorMaintenance(() =>
        assertValidatedInstalledBundle(bundleProbe, this.manifest.id),
      );
    });
    this.addCommand({
      id: "copy-claude-code-mcp-registration",
      name: "Copy Claude Code MCP registration command",
      checkCallback: (checking) => {
        if (runtime.bridge === undefined) return false;
        if (!checking) {
          void navigator.clipboard.writeText(runtime.registrationCommand());
        }
        return true;
      },
    });
    // Spec §9.4: only the Primary Operator, through this local interactive
    // management entry point, may generate a standard diagnostic bundle.
    this.addCommand({
      id: "copy-standard-diagnostic-bundle",
      name: "Copy standard diagnostic bundle",
      callback: () => {
        void runtime
          .createStandardDiagnosticBundle()
          .then(async (bundle) => {
            await navigator.clipboard.writeText(JSON.stringify(bundle));
            const settings = runtime.persistedSettings;
            const bridge = runtime.bridge;
            if (this.#installedRuntimeAcceptance !== undefined && settings !== undefined && bridge !== undefined) {
              await this.#installedRuntimeAcceptance.recordStandardDiagnosticCopy({
                vaultId: settings.vaultId,
                endpoint: new URL(`http://127.0.0.1:${bridge.port}/mcp`),
                bundle,
              });
            }
          })
          .catch((error: unknown) => {
            new Notice(
              error instanceof Error
                ? error.message
                : "Standard diagnostic bundle generation failed",
            );
          });
      },
    });
    // Spec §9.4: only the Primary Operator may request selected
    // content-inclusive diagnostic data, and only after a fresh local
    // interactive confirmation for that generation. The command is available
    // only while the active editor has a non-empty selection; cancel, reject,
    // or a missing selection produces and copies no content-inclusive output.
    this.addCommand({
      id: "copy-selected-content-inclusive-diagnostics",
      name: "Copy selected content-inclusive diagnostics",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const editor = view?.editor;
        const selection = editor?.getSelection() ?? "";
        if (!hasContentInclusiveSelection(selection)) return false;
        if (checking) return true;
        const confirmationId = randomUUID();
        let generatedBundle: Awaited<ReturnType<typeof runtime.createContentInclusiveDiagnosticBundle>> | undefined;
        void performContentInclusiveDiagnosticCopy({
          selection,
          confirm: () =>
            new Promise<boolean>((resolve) => {
              new ContentInclusiveDiagnosticsConfirmationModal(this.app, resolve).open();
            }),
          generate: async (selected) => {
            generatedBundle = await runtime.createContentInclusiveDiagnosticBundle(selected);
            return generatedBundle;
          },
          write: (text) => navigator.clipboard.writeText(text),
        })
          .then(async (outcome) => {
            const settings = runtime.persistedSettings;
            const bridge = runtime.bridge;
            if (this.#installedRuntimeAcceptance !== undefined && settings !== undefined && bridge !== undefined) {
              const binding = { vaultId: settings.vaultId, endpoint: new URL(`http://127.0.0.1:${bridge.port}/mcp`), confirmationId, selection };
              if (outcome.outcome === "cancelled") {
                await this.#installedRuntimeAcceptance.recordContentInclusiveDiagnosticCopy({ ...binding, outcome: "cancelled" });
              } else if (outcome.outcome === "copied" && generatedBundle !== undefined) {
                await this.#installedRuntimeAcceptance.recordContentInclusiveDiagnosticCopy({ ...binding, outcome: "copied", bundle: generatedBundle, copiedTextSha256: outcome.copiedTextSha256 });
              }
            }
            if (outcome.outcome === "copied") {
              new Notice(
                "Selected content-inclusive diagnostics copied to the clipboard",
              );
            }
          })
          .catch((error: unknown) => {
            new Notice(
              error instanceof Error
                ? error.message
                : "Selected content-inclusive diagnostic copy failed",
            );
          });
        return true;
      },
    });
  }

  override async onunload(): Promise<void> {
    const runtime = this.#runtime;
    const installedRuntimeAcceptance = this.#installedRuntimeAcceptance;
    this.#runtime = undefined;
    this.#installedRuntimeAcceptance = undefined;
    installedRuntimeAcceptance?.dispose();
    await runtime?.unload();
  }
}
