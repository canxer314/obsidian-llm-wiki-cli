import { randomInt, randomUUID } from "node:crypto";

import {
  CHANGE_SET_REGISTRY_SCHEMA_VERSION,
  parseChangeSetRegistryState,
  type ChangeSetExecutionAdapter,
  type ChangeSetPreflightDataSource,
  type ChangeSetRegistryState,
} from "./change-set.js";
import type {
  BridgeDiscoverService,
  BridgeHealthState,
  BridgeInstance,
} from "./bridge-instance.js";
import { withMoveReferenceProjection } from "./move-reference-projection.js";
import {
  SearchSnapshotManager,
  SearchSnapshotRefreshCoordinator,
  type SearchSnapshotDataSource,
} from "./search-snapshot.js";
import type { MoveSnapshotBarrier } from "./change-set.js";
import { VaultDiscoverService } from "./vault-discover.js";
import type { VaultReadDataSource } from "./vault-read.js";

export const PERSISTENT_STATE_SCHEMA_VERSION = 2;
const LEGACY_PERSISTENT_STATE_SCHEMA_VERSION = 1;
const MINIMUM_DYNAMIC_PORT = 20_000;
const MAXIMUM_DYNAMIC_PORT = 49_151;

export interface PersistedBridgeSettings {
  schemaVersion:
    | typeof LEGACY_PERSISTENT_STATE_SCHEMA_VERSION
    | typeof PERSISTENT_STATE_SCHEMA_VERSION;
  vaultId: string;
  port: number;
  diagnosticPath: string;
  changeSets?: ChangeSetRegistryState;
}

export interface BridgeSettingsStore {
  load(): Promise<unknown>;
  save(settings: PersistedBridgeSettings): Promise<void>;
  loadRecovery?(): Promise<unknown>;
  saveRecovery?(settings: PersistedBridgeSettings): Promise<void>;
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
    changeSets?: {
      store: {
        load(): Promise<unknown>;
        save(state: ChangeSetRegistryState): Promise<void>;
      };
      dataSource: ChangeSetPreflightDataSource;
      execution?: ChangeSetExecutionAdapter;
      vaultId?: string;
    };
  }): BridgeInstance;
  readDataSource?: VaultReadDataSource;
  searchDataSource?: SearchSnapshotDataSource;
  changeSetDataSource?: ChangeSetPreflightDataSource;
  changeSetExecution?: ChangeSetExecutionAdapter;
  createVaultId?: () => string;
  selectInitialPort?: () => number;
}

function emptyChangeSetState(): ChangeSetRegistryState {
  return {
    schemaVersion: CHANGE_SET_REGISTRY_SCHEMA_VERSION,
    nextEnqueueSeq: 1,
    entries: [],
    tombstones: [],
  };
}

function parsePersistedSettings(value: unknown): {
  settings: PersistedBridgeSettings;
  migrated: boolean;
} | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const settings = value as Record<string, unknown>;
  const isLegacy = settings.schemaVersion === LEGACY_PERSISTENT_STATE_SCHEMA_VERSION;
  const expectedKeys = isLegacy
    ? "diagnosticPath,port,schemaVersion,vaultId"
    : "changeSets,diagnosticPath,port,schemaVersion,vaultId";
  if (
    Object.keys(settings).sort().join(",") !== expectedKeys ||
    (!isLegacy && settings.schemaVersion !== PERSISTENT_STATE_SCHEMA_VERSION) ||
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
  let changeSets: ChangeSetRegistryState;
  try {
    changeSets = isLegacy
      ? emptyChangeSetState()
      : parseChangeSetRegistryState(settings.changeSets);
  } catch {
    return null;
  }
  return {
    settings: {
      schemaVersion: PERSISTENT_STATE_SCHEMA_VERSION,
      vaultId: settings.vaultId,
      port: settings.port,
      diagnosticPath: settings.diagnosticPath,
      changeSets,
    },
    migrated: isLegacy,
  };
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
  #snapshotRefresh: SearchSnapshotRefreshCoordinator | undefined;

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

  async publishSuccessorSearchSnapshot(barrier?: MoveSnapshotBarrier): Promise<void> {
    const snapshots = this.#snapshots;
    const refresh = this.#snapshotRefresh;
    if (snapshots === undefined || refresh === undefined) {
      throw new Error("Search Snapshot publisher is unavailable");
    }
    refresh.schedule();
    await refresh.whenIdle();
    if (snapshots.readiness !== "ready") {
      throw new Error("Successor Search Snapshot publication failed");
    }
    if (barrier !== undefined) {
      const snapshot = snapshots.current();
      const notes = new Map(snapshot?.notes.map((note) => [note.path, note]) ?? []);
      if (
        notes.has(barrier.absentPath) ||
        notes.get(barrier.presentPath)?.contentVersion !== barrier.presentVersion
      ) throw new Error("Successor Search Snapshot move evidence did not match");
      for (const expected of barrier.closure) {
        const note = notes.get(expected.path);
        if (
          note?.contentVersion !== expected.contentVersion ||
          note.resolvedLinks[expected.resolvedPath] !== expected.referenceCount ||
          Object.keys(note.resolvedLinks).some(
            (path) =>
              (path === barrier.presentPath || path === barrier.absentPath) &&
              path !== expected.resolvedPath,
          )
        ) throw new Error("Successor Search Snapshot reference closure did not match");
      }
    }
  }

  scheduleSearchSnapshotRefresh(): void {
    this.#snapshotRefresh?.schedule();
  }

  async #saveSettings(settings: PersistedBridgeSettings): Promise<void> {
    const saveRecovery = this.#options.settings.saveRecovery;
    if (saveRecovery === undefined) {
      await this.#options.settings.save(settings);
      return;
    }
    await saveRecovery(settings);
    try {
      await this.#options.settings.save(settings);
    } catch {
      // The recovery copy is authoritative and is loaded before this best-effort mirror.
    }
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
            changeSets: emptyChangeSetState(),
          };
    if (
      classification === "copy" &&
      (settings.vaultId === previous.vaultId || settings.port === previous.port)
    ) {
      throw new Error("Copy classification must generate a new Vault identity and port");
    }
    await this.#saveSettings(settings);
    this.#settings = settings;
    this.#pendingPathChange = undefined;
  }

  async load(): Promise<void> {
    if (this.#bridge !== undefined) throw new Error("Managed Vault Bridge is already loaded");

    const primarySettings = await this.#options.settings.load();
    const recoverySettings = await this.#options.settings.loadRecovery?.();
    const recoveredPrimary = recoverySettings !== undefined && recoverySettings !== null;
    const rawSettings = recoveredPrimary ? recoverySettings : primarySettings;
    const parsed = parsePersistedSettings(rawSettings);
    if (rawSettings !== undefined && rawSettings !== null && parsed === null) {
      throw new Error("Persisted Bridge settings are incompatible or invalid");
    }
    const loaded = parsed?.settings ?? null;
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
      changeSets: emptyChangeSetState(),
    };

    const hasRecoveryStore = this.#options.settings.saveRecovery !== undefined;
    if (
      loaded === null ||
      recoveredPrimary ||
      (parsed?.migrated === true && hasRecoveryStore)
    ) {
      await this.#saveSettings(settings);
    }
    if (hasRecoveryStore && !recoveredPrimary && loaded !== null) {
      await this.#options.settings.saveRecovery?.(settings);
    }

    const snapshots =
      this.#options.searchDataSource === undefined
        ? undefined
        : new SearchSnapshotManager(this.#options.searchDataSource);
    this.#snapshots = snapshots;
    this.#snapshotRefresh = snapshots === undefined
      ? undefined
      : new SearchSnapshotRefreshCoordinator(snapshots);
    if (snapshots !== undefined) {
      try {
        await snapshots.rebuild();
      } catch {
        // The Bridge still starts so vault_health can report fail-closed readiness.
      }
    }
    const changeSetStore = {
      load: async () => settings.changeSets,
      save: async (changeSets: ChangeSetRegistryState) => {
        const nextSettings = { ...settings, changeSets };
        await this.#saveSettings(nextSettings);
        settings.changeSets = changeSets;
        this.#settings = settings;
      },
    };
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
        write:
          this.#options.changeSetDataSource === undefined
            ? { gate: "blocked", state: "paused", pauseSource: "maintenance" }
            : { gate: "open", state: "writable", pauseSource: null },
        queue: { currentExecutionId: null, length: 0, headChangeSetId: null },
        lifecycle: {
          startup: "ready",
          upgrade: "not_run",
          migration: "not_run",
          recovery: "not_run",
        },
        effectiveGate:
          this.#options.changeSetDataSource === undefined
            ? { code: "writes_paused" }
            : null,
        overall:
          this.#options.changeSetDataSource === undefined
            ? "blocked"
            : snapshots?.readiness === "ready" &&
                this.#options.changeSetExecution !== undefined
              ? "healthy"
              : "degraded",
        reasonCodes:
          snapshots?.readiness !== "ready"
            ? ["content_tools_not_ready"]
            : this.#options.changeSetDataSource === undefined
              ? ["writes_paused"]
              : this.#options.changeSetExecution === undefined
                ? ["mutation_executor_not_ready"]
                : [],
        operatorAction:
          snapshots?.readiness !== "ready"
            ? "finish_initialization"
            : this.#options.changeSetDataSource === undefined
              ? "resume_writes"
              : this.#options.changeSetExecution === undefined
                ? "wait_for_readiness"
                : "none",
      },
      readDataSource: this.#options.readDataSource,
      discoverService: snapshots === undefined ? undefined : new VaultDiscoverService(snapshots),
      searchSnapshotReadiness:
        snapshots === undefined ? undefined : () => snapshots.readiness,
      changeSets:
        this.#options.changeSetDataSource === undefined
          ? undefined
          : {
              store: changeSetStore,
              dataSource:
                snapshots === undefined
                  ? this.#options.changeSetDataSource
                  : withMoveReferenceProjection(
                      this.#options.changeSetDataSource,
                      snapshots,
                    ),
              execution: this.#options.changeSetExecution,
              vaultId: settings.vaultId,
            },
    });

    await bridge.start();
    if (parsed?.migrated === true && !hasRecoveryStore) {
      await this.#options.settings.save(settings);
    }
    this.#settings = settings;
    this.#bridge = bridge;
  }

  async unload(): Promise<void> {
    const bridge = this.#bridge;
    this.#bridge = undefined;
    this.#snapshots = undefined;
    this.#snapshotRefresh?.dispose();
    this.#snapshotRefresh = undefined;
    if (bridge !== undefined) await bridge.stop();
    await this.#options.changeSetExecution?.close?.();
  }

  registrationCommand(serverName?: string): string {
    if (this.#bridge === undefined) throw new Error("Managed Vault Bridge is not loaded");
    return this.#bridge.registrationCommand(serverName);
  }
}
