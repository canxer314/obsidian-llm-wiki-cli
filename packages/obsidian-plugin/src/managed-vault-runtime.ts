import { randomInt, randomUUID } from "node:crypto";

import type { BridgeHealthState, BridgeInstance } from "./bridge-instance.js";

export const PERSISTENT_STATE_SCHEMA_VERSION = 1;
const MINIMUM_DYNAMIC_PORT = 20_000;
const MAXIMUM_DYNAMIC_PORT = 49_151;

export interface PersistedBridgeSettings {
  schemaVersion: typeof PERSISTENT_STATE_SCHEMA_VERSION;
  vaultId: string;
  port: number;
  diagnosticPath: string;
}

export interface BridgeSettingsStore {
  load(): Promise<unknown>;
  save(settings: PersistedBridgeSettings): Promise<void>;
}

export interface ManagedVaultDescriptor {
  name: string;
  path: string;
}

export interface PathChangeEvidence {
  previousPath: string;
  currentPath: string;
}

export type PathChangeClassification = "move" | "copy";

export interface ManagedVaultBridgeRuntimeOptions {
  vault: ManagedVaultDescriptor;
  settings: BridgeSettingsStore;
  createBridge(options: {
    port: number;
    health: BridgeHealthState;
  }): BridgeInstance;
  createVaultId?: () => string;
  selectInitialPort?: () => number;
}

function parsePersistedSettings(value: unknown): PersistedBridgeSettings | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const settings = value as Record<string, unknown>;
  const keys = Object.keys(settings).sort();
  if (
    keys.join(",") !== "diagnosticPath,port,schemaVersion,vaultId" ||
    settings.schemaVersion !== PERSISTENT_STATE_SCHEMA_VERSION ||
    typeof settings.vaultId !== "string" ||
    settings.vaultId.length === 0 ||
    typeof settings.port !== "number" ||
    !Number.isInteger(settings.port) ||
    settings.port < 1 ||
    settings.port > 65_535 ||
    typeof settings.diagnosticPath !== "string" ||
    settings.diagnosticPath.length === 0
  ) {
    return null;
  }
  return settings as unknown as PersistedBridgeSettings;
}

export class VaultPathChangeRequiredError extends Error {
  constructor(readonly evidence: PathChangeEvidence) {
    super("Vault path change classification required before Bridge startup");
    this.name = "VaultPathChangeRequiredError";
  }
}

export class ManagedVaultBridgeRuntime {
  readonly #options: ManagedVaultBridgeRuntimeOptions;
  #bridge: BridgeInstance | undefined;
  #settings: PersistedBridgeSettings | undefined;
  #pendingPathChange: PathChangeEvidence | undefined;

  constructor(options: ManagedVaultBridgeRuntimeOptions) {
    this.#options = options;
  }

  get bridge(): BridgeInstance | undefined {
    return this.#bridge;
  }

  get persistedSettings(): PersistedBridgeSettings | undefined {
    return this.#settings;
  }

  get pendingPathChange(): PathChangeEvidence | undefined {
    return this.#pendingPathChange;
  }

  async classifyPathChange(classification: PathChangeClassification): Promise<void> {
    const pathChange = this.#pendingPathChange;
    const previous = this.#settings;
    if (pathChange === undefined || previous === undefined) {
      throw new Error("No Vault path change is awaiting classification");
    }

    const settings: PersistedBridgeSettings =
      classification === "move"
        ? { ...previous, diagnosticPath: pathChange.currentPath }
        : {
            schemaVersion: PERSISTENT_STATE_SCHEMA_VERSION,
            vaultId: (this.#options.createVaultId ?? randomUUID)(),
            port:
              this.#options.selectInitialPort?.() ??
              randomInt(MINIMUM_DYNAMIC_PORT, MAXIMUM_DYNAMIC_PORT + 1),
            diagnosticPath: pathChange.currentPath,
          };
    if (
      classification === "copy" &&
      (settings.vaultId === previous.vaultId || settings.port === previous.port)
    ) {
      throw new Error("Copy classification must generate a new Vault identity and port");
    }
    await this.#options.settings.save(settings);
    this.#settings = settings;
    this.#pendingPathChange = undefined;
  }

  async load(): Promise<void> {
    if (this.#bridge !== undefined) throw new Error("Managed Vault Bridge is already loaded");

    const rawSettings = await this.#options.settings.load();
    const loaded = parsePersistedSettings(rawSettings);
    if (rawSettings !== undefined && rawSettings !== null && loaded === null) {
      throw new Error("Persisted Bridge settings are incompatible or invalid");
    }
    if (loaded !== null && loaded.diagnosticPath !== this.#options.vault.path) {
      this.#settings = loaded;
      this.#pendingPathChange = {
        previousPath: loaded.diagnosticPath,
        currentPath: this.#options.vault.path,
      };
      throw new VaultPathChangeRequiredError(this.#pendingPathChange);
    }
    const settings = loaded ?? {
      schemaVersion: PERSISTENT_STATE_SCHEMA_VERSION,
      vaultId: (this.#options.createVaultId ?? randomUUID)(),
      port:
        this.#options.selectInitialPort?.() ??
        randomInt(MINIMUM_DYNAMIC_PORT, MAXIMUM_DYNAMIC_PORT + 1),
      diagnosticPath: this.#options.vault.path,
    };

    if (loaded === null) await this.#options.settings.save(settings);

    const bridge = this.#options.createBridge({
      port: settings.port,
      health: {
        vault: {
          id: settings.vaultId,
          name: this.#options.vault.name,
          path: settings.diagnosticPath,
        },
        readiness: {
          searchSnapshot: "unavailable",
          cache: "unavailable",
          index: "unavailable",
        },
        recovery: { state: "none" },
        write: { gate: "blocked", state: "paused", pauseSource: "maintenance" },
        queue: { currentExecutionId: null, length: 0, headChangeSetId: null },
        lifecycle: {
          startup: "ready",
          upgrade: "not_run",
          migration: "not_run",
          recovery: "not_run",
        },
        effectiveGate: { code: "writes_paused" },
        overall: "blocked",
        reasonCodes: ["content_tools_not_ready"],
        operatorAction: "finish_initialization",
      },
    });

    await bridge.start();
    this.#settings = settings;
    this.#bridge = bridge;
  }

  async unload(): Promise<void> {
    const bridge = this.#bridge;
    this.#bridge = undefined;
    if (bridge !== undefined) await bridge.stop();
  }

  registrationCommand(serverName?: string): string {
    if (this.#bridge === undefined) throw new Error("Managed Vault Bridge is not loaded");
    return this.#bridge.registrationCommand(serverName);
  }
}
