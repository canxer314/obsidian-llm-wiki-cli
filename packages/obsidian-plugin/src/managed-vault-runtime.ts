import { randomInt, randomUUID } from "node:crypto";

import {
  CHANGE_SET_REGISTRY_SCHEMA_VERSION,
  parseChangeSetRegistryState,
  type ChangeSetExecutionAdapter,
  type ChangeSetPreflightDataSource,
  type ChangeSetRegistryState,
  type MoveSnapshotBarrier,
  type SearchSnapshotTargetEvidence,
} from "./change-set.js";
import type {
  BridgeDiscoverService,
  BridgeHealthState,
  BridgeInstance,
  BridgeMaintenanceOperation,
} from "./bridge-instance.js";
import { withMoveReferenceProjection } from "./move-reference-projection.js";
import {
  SearchSnapshotManager,
  SearchSnapshotRefreshCoordinator,
  type SearchSnapshotDataSource,
} from "./search-snapshot.js";
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
    incompatibleState?: boolean;
  }): BridgeInstance;
  readDataSource?: VaultReadDataSource;
  searchDataSource?: SearchSnapshotDataSource;
  changeSetDataSource?: ChangeSetPreflightDataSource;
  changeSetExecution?: ChangeSetExecutionAdapter;
  incompatibleState?: boolean;
  createVaultId?: () => string;
  selectInitialPort?: () => number;
  successBarrierTimeoutMs?: number;
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

function parsePersistedEnvelope(
  value: unknown,
  forceRestricted = false,
): PersistedBridgeSettings | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const settings = value as Record<string, unknown>;
  const schemaIncompatible =
    typeof settings.schemaVersion === "number" &&
    Number.isInteger(settings.schemaVersion) &&
    settings.schemaVersion > PERSISTENT_STATE_SCHEMA_VERSION;
  const changeSets = schemaIncompatible ? undefined : settings.changeSets;
  const registrySchema =
    typeof changeSets === "object" && changeSets !== null && !Array.isArray(changeSets)
      ? (changeSets as Record<string, unknown>).schemaVersion
      : undefined;
  const registryIncompatible =
    settings.schemaVersion === PERSISTENT_STATE_SCHEMA_VERSION &&
    typeof registrySchema === "number" &&
    Number.isInteger(registrySchema) &&
    registrySchema > CHANGE_SET_REGISTRY_SCHEMA_VERSION;
  if (
    (!forceRestricted && !schemaIncompatible && !registryIncompatible) ||
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
  return {
    schemaVersion: PERSISTENT_STATE_SCHEMA_VERSION,
    vaultId: settings.vaultId,
    port: settings.port,
    diagnosticPath: settings.diagnosticPath,
    changeSets: emptyChangeSetState(),
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
  #snapshotSignals: Array<(error?: Error) => void> = [];

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

  async publishSuccessorSearchSnapshot(
    targets: readonly SearchSnapshotTargetEvidence[] = [],
    moveBarrier?: MoveSnapshotBarrier,
  ): Promise<void> {
    const snapshots = this.#snapshots;
    const refresh = this.#snapshotRefresh;
    if (snapshots === undefined || refresh === undefined) {
      throw new Error("Search Snapshot publisher is unavailable");
    }
    const matches = (): boolean => {
      if (snapshots.readiness !== "ready") return false;
      const notes = new Map(
        snapshots.current()?.notes.map((note) => [note.path, note]) ?? [],
      );
      const targetsMatch = targets.every(({ path, contentVersion, requireSemanticMatch }) => {
        const note = notes.get(path);
        if (note?.contentVersion !== contentVersion) return false;
        // A semantic observation for a different version is stale/late and fails.
        // For a changed note, absence of any observation is not yet proof.
        if (requireSemanticMatch === true) {
          return note.semanticContentVersion === contentVersion;
        }
        if (
          note.semanticContentVersion !== undefined &&
          note.semanticContentVersion !== contentVersion
        ) return false;
        return true;
      });
      if (!targetsMatch) return false;
      if (moveBarrier === undefined) return true;
      // A note move additionally requires the rename to be visible and every
      // closure note to resolve its references to the moved note (issue #38).
      if (
        notes.has(moveBarrier.absentPath) ||
        notes.get(moveBarrier.presentPath)?.contentVersion !== moveBarrier.presentVersion
      ) return false;
      return moveBarrier.closure.every((expected) => {
        const note = notes.get(expected.path);
        return (
          note?.contentVersion === expected.contentVersion &&
          note.resolvedLinks[expected.resolvedPath] === expected.referenceCount &&
          !Object.keys(note.resolvedLinks).some(
            (path) =>
              (path === moveBarrier.presentPath || path === moveBarrier.absentPath) &&
              path !== expected.resolvedPath,
          )
        );
      });
    };
    const deadline = Date.now() + (this.#options.successBarrierTimeoutMs ?? 5_000);
    refresh.schedule();
    while (true) {
      try {
        await refresh.whenIdle();
      } catch (error) {
        if (this.#snapshotRefresh !== refresh) {
          throw new Error("Search Snapshot barrier ended because the runtime unloaded", {
            cause: error,
          });
        }
        // A failed build leaves readiness unavailable; the barrier keeps waiting
        // for a later host event until the deadline rather than failing open.
      }
      if (this.#snapshotRefresh !== refresh) {
        throw new Error("Search Snapshot barrier ended because the runtime unloaded");
      }
      if (matches()) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("Successor Search Snapshot target evidence did not match");
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, remaining);
        timer.unref?.();
        const signal = (error?: Error) => {
          clearTimeout(timer);
          if (error === undefined) resolve();
          else reject(error);
        };
        this.#snapshotSignals.push(signal);
      });
    }
  }

  scheduleSearchSnapshotRefresh(): void {
    this.#snapshotRefresh?.schedule();
    for (const signal of this.#snapshotSignals.splice(0)) signal();
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
    const parsed = this.#options.incompatibleState === true
      ? null
      : parsePersistedSettings(rawSettings);
    const incompatibleEnvelope =
      parsed === null
        ? parsePersistedEnvelope(rawSettings, this.#options.incompatibleState === true)
        : null;
    if (
      rawSettings !== undefined &&
      rawSettings !== null &&
      parsed === null &&
      incompatibleEnvelope === null
    ) {
      throw new Error("Persisted Bridge settings are incompatible or invalid");
    }
    const restricted = incompatibleEnvelope !== null || this.#options.incompatibleState === true;
    const loaded = parsed?.settings ?? incompatibleEnvelope;
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
      (loaded === null ||
        (!restricted &&
          (recoveredPrimary || (parsed?.migrated === true && hasRecoveryStore))))
    ) {
      await this.#saveSettings(settings);
    }
    if (hasRecoveryStore && !recoveredPrimary && loaded !== null && !restricted) {
      await this.#options.settings.saveRecovery?.(settings);
    }

    const snapshots =
      restricted || this.#options.searchDataSource === undefined
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
    const persistedWriteMode = restricted ? undefined : settings.changeSets?.writeMode;
    const recoveryPending =
      !restricted && settings.changeSets?.recovery !== undefined &&
      settings.changeSets.recovery.state !== "none";
    const writeUnavailable = this.#options.changeSetDataSource === undefined;
    const persistedPaused = persistedWriteMode !== undefined;
    const persistedLifecycle = restricted ? undefined : settings.changeSets?.lifecycle;
    const maintenancePaused = persistedWriteMode === "maintenance_paused";
    const maintenanceFailed = persistedWriteMode === "maintenance_failed";
    const maintenancePending =
      persistedWriteMode === "maintenance_pending" || maintenanceFailed;
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
        recovery: recoveryPending ? { state: "blocked" } : { state: "none" },
        write:
          recoveryPending || writeUnavailable || persistedPaused
            ? {
                gate: recoveryPending || writeUnavailable || maintenanceFailed ? "blocked" : "open",
                state: "paused",
                pauseSource:
                  recoveryPending || writeUnavailable || maintenancePaused || maintenancePending
                    ? "maintenance"
                    : "manual",
              }
            : { gate: "open", state: "writable", pauseSource: null },
        queue: { currentExecutionId: null, length: 0, headChangeSetId: null },
        lifecycle: {
          startup: "ready",
          upgrade: persistedLifecycle?.upgrade ?? "not_run",
          migration: persistedLifecycle?.migration ?? "not_run",
          recovery: "not_run",
        },
        effectiveGate:
          recoveryPending
            ? { code: "recovery_blocked" }
            : writeUnavailable || persistedPaused
              ? { code: maintenancePending ? "upgrade_in_progress" : "writes_paused" }
              : null,
        overall:
          recoveryPending || writeUnavailable || maintenancePending
            ? "blocked"
            : persistedPaused
              ? "degraded"
              : snapshots?.readiness === "ready" &&
                  this.#options.changeSetExecution !== undefined
                ? "healthy"
                : "degraded",
        reasonCodes:
          recoveryPending
            ? ["recovery_blocked"]
            : maintenanceFailed
              ? ["upgrade_failed"]
            : snapshots?.readiness !== "ready"
              ? ["content_tools_not_ready"]
              : writeUnavailable
                ? ["writes_paused"]
                : maintenancePending
                  ? ["upgrade_in_progress"]
                  : persistedPaused
                    ? ["writes_paused"]
                    : this.#options.changeSetExecution === undefined
                      ? ["mutation_executor_not_ready"]
                      : [],
        operatorAction:
          recoveryPending
            ? "review_recovery"
            : maintenanceFailed
              ? "finish_upgrade"
            : snapshots?.readiness !== "ready"
              ? "finish_initialization"
              : writeUnavailable || persistedPaused
                ? maintenancePending
                  ? "finish_upgrade"
                  : "resume_writes"
                : this.#options.changeSetExecution === undefined
                  ? "wait_for_readiness"
                  : "none",
      },
      readDataSource: restricted ? undefined : this.#options.readDataSource,
      discoverService: snapshots === undefined ? undefined : new VaultDiscoverService(snapshots),
      searchSnapshotReadiness:
        snapshots === undefined ? undefined : () => snapshots.readiness,
      changeSets:
        restricted || this.#options.changeSetDataSource === undefined
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
      incompatibleState: restricted,
    });

    await bridge.start();
    if (parsed?.migrated === true && !hasRecoveryStore) {
      await this.#options.settings.save(settings);
    }
    this.#settings = settings;
    this.#bridge = bridge;
  }

  async pauseWrites(): Promise<void> {
    const bridge = this.#bridge;
    if (bridge === undefined) throw new Error("Managed Vault Bridge is not loaded");
    await bridge.pauseWrites();
  }

  async runMaintenance(operation: BridgeMaintenanceOperation): Promise<void> {
    const bridge = this.#bridge;
    if (bridge === undefined) throw new Error("Managed Vault Bridge is not loaded");
    await bridge.runMaintenance(operation);
  }

  /**
   * Production maintenance entry for the Primary Operator (spec §9.2).
   * The host supplies `replaceValidatedBundle` because release-file
   * replacement is environment-specific; state migration and the health
   * recheck are production responsibilities of this runtime and fail
   * closed. A successful run remains maintenance-paused until
   * `resumeWrites()` is invoked explicitly.
   */
  async runOperatorMaintenance(
    replaceValidatedBundle: () => void | Promise<void>,
  ): Promise<void> {
    await this.runMaintenance({
      replaceValidatedBundle,
      migrateState: async () => {
        const validated = parsePersistedSettings(this.#settings);
        if (validated === null) {
          throw new Error("Persisted Bridge state failed fail-closed maintenance validation");
        }
        await this.#saveSettings(validated.settings);
        this.#settings = validated.settings;
      },
      recheckHealth: () => this.refreshSearchSnapshot(),
    });
  }

  async acceptTrustedRecoveryBaseline(): Promise<void> {
    const bridge = this.#bridge;
    if (bridge === undefined) throw new Error("Managed Vault Bridge is not loaded");
    await bridge.acceptTrustedRecoveryBaseline(() => this.refreshSearchSnapshot());
  }

  async resumeWrites(): Promise<void> {
    const bridge = this.#bridge;
    if (bridge === undefined) throw new Error("Managed Vault Bridge is not loaded");
    await bridge.resumeWrites();
  }

  async unload(): Promise<void> {
    const bridge = this.#bridge;
    this.#bridge = undefined;
    this.#snapshots = undefined;
    const refresh = this.#snapshotRefresh;
    this.#snapshotRefresh = undefined;
    const lifecycleError = new Error(
      "Search Snapshot barrier ended because the runtime unloaded",
    );
    for (const signal of this.#snapshotSignals.splice(0)) signal(lifecycleError);
    refresh?.dispose();
    if (bridge !== undefined) await bridge.stop();
    await this.#options.changeSetExecution?.close?.();
  }

  registrationCommand(serverName?: string): string {
    if (this.#bridge === undefined) throw new Error("Managed Vault Bridge is not loaded");
    return this.#bridge.registrationCommand(serverName);
  }
}
