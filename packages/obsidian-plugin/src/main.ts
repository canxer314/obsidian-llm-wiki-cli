import {
  FileSystemAdapter,
  Plugin,
  TFile,
  getFrontMatterInfo,
  parseYaml,
} from "obsidian";

import { createBridgeInstance } from "./bridge-instance.js";
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
    const runtime = new ManagedVaultBridgeRuntime({
      vault: { name: this.app.vault.getName(), path: basePath },
      settings: {
        load: () => this.loadData() as Promise<unknown>,
        save: (settings) => this.saveData(settings),
      },
      searchDataSource: {
        listMarkdownPaths: async () =>
          this.app.vault.getMarkdownFiles().map(({ path }) => path),
        readBinary: async (path) => {
          const file = this.app.vault.getFileByPath(path);
          return file === null ? null : this.app.vault.readBinary(file);
        },
      },
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
      createBridge: createBridgeInstance,
    });
    this.#runtime = runtime;
    let refreshQueue = Promise.resolve();
    const scheduleRefresh = (): void => {
      refreshQueue = refreshQueue
        .then(() => runtime.refreshSearchSnapshot())
        .catch(() => undefined);
    };
    const scheduleMarkdownRefresh = (file: unknown): void => {
      if (file instanceof TFile && file.extension === "md") scheduleRefresh();
    };
    this.registerEvent(this.app.vault.on("create", scheduleMarkdownRefresh));
    this.registerEvent(this.app.vault.on("modify", scheduleMarkdownRefresh));
    this.registerEvent(this.app.vault.on("delete", scheduleMarkdownRefresh));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (
          (file instanceof TFile && file.extension === "md") ||
          oldPath.endsWith(".md")
        ) {
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
