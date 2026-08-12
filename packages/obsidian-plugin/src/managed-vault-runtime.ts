import { randomInt, randomUUID } from "node:crypto";

import type {
  BridgeDiscoverService,
  BridgeHealthState,
  BridgeInstance,
} from "./bridge-instance.js";
import { SearchSnapshotManager, type SearchSnapshotDataSource } from "./search-snapshot.js";
import { VaultDiscoverService } from "./vault-discover.js";
import type { VaultReadDataSource } from "./vault-read.js";

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
    readDataSource?: VaultReadDataSource;
    discoverService?: BridgeDiscoverService;
    searchSnapshotReadiness?: () => "ready" | "building" | "unavailable";
  }): BridgeInstance;
  readDataSource?: VaultReadDataSource;
  searchDataSource?: SearchSnapshotDataSource;
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
  #snapshots: SearchSnapshotManager | undefined;

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

  async refreshSearchSnapshot(): Promise<void> {
    const snapshots = this.#snapshots;
    if (snapshots === undefined) return;
    await snapshots.rebuild();
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

    const snapshots =
      this.#options.searchDataSource === undefined
        ? undefined
        : new SearchSnapshotManager(this.#options.searchDataSource);
    this.#snapshots = snapshots;
    if (snapshots !== undefined) {
      try {
        await snapshots.rebuild();
      } catch {
        // The Bridge still starts so vault_health can report fail-closed readiness.
      }
    }
    const bridge = this.#options.createBridge({
      port: settings.port,
      health: {
        vault: {
          id: settings.vaultId,
          name: this.#options.vault.name,
          path: settings.diagnosticPath,
        },
        readiness: {
          searchSnapshot: snapshots?.readiness ?? "unavailable",
          cache: "unavailable",
          index: snapshots?.readiness === "ready" ? "ready" : "unavailable",
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
        reasonCodes:
          snapshots?.readiness === "ready"
            ? ["writes_paused"]
            : ["content_tools_not_ready"],
        operatorAction:
          snapshots?.readiness === "ready"
            ? "resume_writes"
            : "finish_initialization",
      },
      readDataSource: this.#options.readDataSource,
      discoverService: snapshots === undefined ? undefined : new VaultDiscoverService(snapshots),
      searchSnapshotReadiness:
        snapshots === undefined ? undefined : () => snapshots.readiness,
    });

    await bridge.start();
    this.#settings = settings;
    this.#bridge = bridge;
  }

  async unload(): Promise<void> {
    const bridge = this.#bridge;
    this.#bridge = undefined;
    this.#snapshots = undefined;
    if (bridge !== undefined) await bridge.stop();
  }

  registrationCommand(serverName?: string): string {
    if (this.#bridge === undefined) throw new Error("Managed Vault Bridge is not loaded");
    return this.#bridge.registrationCommand(serverName);
  }
}
