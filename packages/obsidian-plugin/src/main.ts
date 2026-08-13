import { mkdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  FileSystemAdapter,
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
import { createFileSystemChangeSetDataSource } from "./file-system-change-set-data-source.js";
import { createFileSystemChangeSetExecutionAdapter } from "./file-system-change-set-execution.js";
import {
  ObsidianSemanticVersionTracker,
  createObsidianSearchDataSource,
  enumerateCanonicalReferenceTargets,
  isRegisteredSubpathResult,
} from "./obsidian-search-data-source.js";
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
    const stateDirectory = join(basePath, ".llm-wiki");
    const recoveryStatePath = join(stateDirectory, "bridge-state.json");
    const recoveryStateTemporaryPath = join(stateDirectory, "bridge-state.next");
    const recoveryJournalPath = join(stateDirectory, "recovery-journal.bin");
    const stagingDirectory = join(stateDirectory, "staging");
    const vaultPath = (path: string) => join(basePath, ...path.split("/"));
    const stagePath = (stageId: string) => join(stagingDirectory, ...stageId.split("/"));
    const pathIdentity = async (
      path: string,
      expectedKind: "directory" | "file",
    ): Promise<string | null> => {
      try {
        const value = await stat(vaultPath(path));
        const matches = expectedKind === "directory" ? value.isDirectory() : value.isFile();
        return matches ? `${value.dev}:${value.ino}:${value.birthtimeMs}` : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    };
    let runtime!: ManagedVaultBridgeRuntime;
    const semanticVersions = new ObsidianSemanticVersionTracker();
    const changeSetExecution =
      adapter instanceof FileSystemAdapter
        ? await createFileSystemChangeSetExecutionAdapter({
            journalPath: recoveryJournalPath,
            host: {
              pathKind: async (path) => {
                const value = await adapter.stat(path);
                if (value === null) return null;
                return value.type === "folder" ? "directory" : "file";
              },
              directoryIdentity: (path) => pathIdentity(path, "directory"),
              prepareDirectory: async (stageId) => {
                const path = stagePath(stageId);
                await mkdir(path, { recursive: true });
                const value = await stat(path);
                return `${value.dev}:${value.ino}:${value.birthtimeMs}`;
              },
              publishDirectory: (stageId, path) =>
                rename(stagePath(stageId), vaultPath(path)),
              discardPreparedDirectory: async (stageId) => {
                try {
                  await rmdir(stagePath(stageId));
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                }
              },
              removeDirectory: (path) => adapter.rmdir(path, false),
              readBinary: changeSetDataSource!.readBinary,
              fileIdentity: (path) => pathIdentity(path, "file"),
              prepareFile: async (stageId, bytes) => {
                const path = stagePath(stageId);
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, bytes, { flag: "wx" });
                const value = await stat(path);
                return `${value.dev}:${value.ino}:${value.birthtimeMs}`;
              },
              publishFile: (stageId, path) =>
                rename(stagePath(stageId), vaultPath(path)),
              discardPreparedFile: async (stageId) => {
                await unlink(stagePath(stageId)).catch(
                  (error: NodeJS.ErrnoException) => {
                    if (error.code !== "ENOENT") throw error;
                  },
                );
              },
              removeFile: async (path) => {
                await unlink(vaultPath(path));
              },
              publishSearchSnapshot: async (targets) => {
                await runtime.publishSuccessorSearchSnapshot(targets);
              },
            },
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
    this.registerEvent(this.app.vault.on("create", scheduleMarkdownRefresh));
    this.registerEvent(this.app.vault.on("modify", scheduleMarkdownRefresh));
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          semanticVersions.remove(file.path);
          scheduleRefresh();
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
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
  }

  override async onunload(): Promise<void> {
    const runtime = this.#runtime;
    this.#runtime = undefined;
    await runtime?.unload();
  }
}
