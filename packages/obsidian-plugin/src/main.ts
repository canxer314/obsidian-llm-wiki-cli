import { FileSystemAdapter, Plugin } from "obsidian";

import { createBridgeInstance } from "./bridge-instance.js";
import { ManagedVaultBridgeRuntime } from "./managed-vault-runtime.js";

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
      createBridge: createBridgeInstance,
    });
    this.#runtime = runtime;

    await runtime.load();
    this.addCommand({
      id: "copy-claude-code-mcp-registration",
      name: "Copy Claude Code MCP registration command",
      callback: () => {
        void navigator.clipboard.writeText(runtime.registrationCommand());
      },
    });
  }

  override async onunload(): Promise<void> {
    const runtime = this.#runtime;
    this.#runtime = undefined;
    await runtime?.unload();
  }
}
