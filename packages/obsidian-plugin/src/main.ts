import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  FileSystemAdapter,
  Notice,
  Plugin,
  TFile,
  getAllTags,
  getFrontMatterInfo,
  parseFrontMatterAliases,
  parseLinktext,
  parseYaml,
  resolveSubpath,
} from "obsidian";

import { createBridgeInstance } from "./bridge-instance.js";
import { BRIDGE_STATE_DIRECTORY_NAME } from "./change-set.js";
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
  ManagedVaultBridgeRuntime,
  VaultPathChangeRequiredError,
  type PathChangeClassification,
} from "./managed-vault-runtime.js";

export default class VaultOperationBridgePlugin extends Plugin {
  #runtime: ManagedVaultBridgeRuntime | undefined;

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
    let runtime!: ManagedVaultBridgeRuntime;
    let incompatibleState = false;
    const semanticVersions = new ObsidianSemanticVersionTracker();
    const referenced = async (path: string): Promise<boolean> =>
      Object.values(this.app.metadataCache.resolvedLinks).some(
        (targets) => targets[path] !== undefined,
      );
    const semanticEvidence = createChangeSetSemanticEvidenceTracker({
      publishSuccessorSearchSnapshot: async () => {
        await runtime.publishSuccessorSearchSnapshot();
      },
      probes: {
        cacheVisible: async (path) => {
          const file = this.app.vault.getFileByPath(path);
          return file !== null && this.app.metadataCache.getFileCache(file) !== null;
        },
        referenced,
      },
    });
    const changeSetExecution =
      adapter instanceof FileSystemAdapter
        ? await createFileSystemChangeSetExecutionAdapter({
            journalPath: recoveryJournalPath,
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
                semanticEvidence.begin(request);
              },
              awaitSemanticEvidence: async (request) => {
                await semanticEvidence.await(request);
              },
              semanticEvidencePublishesSnapshot: true,
              publishSearchSnapshot: async (targets, moveBarrier) => {
                await runtime.publishSuccessorSearchSnapshot(targets, moveBarrier);
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
        semanticContentMatches: (path, bytes) => semanticVersions.matches(path, bytes),
        resolveLink: (target, sourcePath) =>
          this.app.metadataCache.getFirstLinkpathDest(target, sourcePath)?.path ?? null,
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
      incompatibleState,
      createBridge: createBridgeInstance,
    });
    this.#runtime = runtime;
    const scheduleRefresh = (): void => {
      runtime.scheduleSearchSnapshotRefresh();
    };
    const scheduleMarkdownRefresh = (file: unknown): void => {
      if (file instanceof TFile && file.extension === "md") scheduleRefresh();
    };
    this.registerEvent(
      this.app.metadataCache.on("changed", (file, data) => {
        if (file instanceof TFile && file.extension === "md") {
          semanticVersions.observe(file.path, data);
          scheduleRefresh();
        }
      }),
    );
    this.registerEvent(this.app.metadataCache.on("resolve", scheduleMarkdownRefresh));
    this.registerEvent(this.app.metadataCache.on("resolved", scheduleRefresh));
    this.registerEvent(this.app.vault.on("create", (file) => {
      semanticEvidence.record({ kind: "create", path: file.path });
      scheduleMarkdownRefresh(file);
    }));
    this.registerEvent(this.app.vault.on("modify", scheduleMarkdownRefresh));
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        semanticEvidence.record({ kind: "delete", path: file.path });
        if (file instanceof TFile && file.extension === "md") {
          semanticVersions.remove(file.path);
          scheduleRefresh();
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        semanticEvidence.record({ kind: "rename", oldPath, path: file.path });
        if (file instanceof TFile && file.extension === "md") {
          semanticVersions.rename(oldPath, file.path);
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
    this.addCommand({
      id: "pause-managed-vault-writes",
      name: "Pause Managed Vault writes",
      callback: () => runtime.pauseWrites(),
    });
    this.addCommand({
      id: "resume-managed-vault-writes",
      name: "Resume Managed Vault writes",
      callback: () => runtime.resumeWrites(),
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
  }

  override async onunload(): Promise<void> {
    const runtime = this.#runtime;
    this.#runtime = undefined;
    await runtime?.unload();
  }
}
