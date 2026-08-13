export {
  createBridgeInstance,
  type BridgeDiscoverService,
  type BridgeHealthState,
  type BridgeInstance,
  type BridgeInstanceOptions,
  type BridgeRequestAuthenticator,
  type ProtocolParticipant,
} from "./bridge-instance.js";
export {
  CHANGE_SET_RECORD_RETENTION_MS,
  CHANGE_SET_REGISTRY_SCHEMA_VERSION,
  ChangeSetService,
  fingerprintChangeSetRequest,
  type FrontmatterChange,
  type MoveDerivedProjection,
  type MoveProjection,
  type ChangeSetExecutionAdapter,
  type ChangeSetExecutionState,
  type ChangeSetRuntimeStatePort,
  type RecoveryJournalFrame,
  type RecoveryJournalPhase,
  InjectedChangeSetCrash,
  type ChangeSetGate,
  type ChangeSetPathKind,
  type ChangeSetPreflightDataSource,
  type ChangeSetRegistryEntry,
  type ChangeSetRegistryState,
  type ChangeSetRegistryStore,
  type ChangeSetRegistryTombstone,
  type ChangeSetRequestState,
  type ChangeSetServiceOptions,
} from "./change-set.js";
export { createFileSystemChangeSetDataSource } from "./file-system-change-set-data-source.js";
export {
  DEFAULT_RECOVERY_JOURNAL_SLOT_CAPACITY,
  createFileSystemChangeSetExecutionAdapter,
  type DirectoryExecutionHost,
  type FileSystemChangeSetExecutionOptions,
} from "./file-system-change-set-execution.js";
export { createRegistrationCommand } from "./registration-command.js";
export {
  ManagedVaultBridgeRuntime,
  PERSISTENT_STATE_SCHEMA_VERSION,
  VaultPathChangeRequiredError,
  type BridgeSettingsStore,
  type ManagedVaultBridgeRuntimeOptions,
  type ManagedVaultDescriptor,
  type PathChangeClassification,
  type PathChangeEvidence,
  type PersistedBridgeSettings,
} from "./managed-vault-runtime.js";
export {
  MAXIMUM_LOGICAL_EXACT_READ_BYTES,
  performVaultRead,
  type VaultReadDataSource,
  type VaultReadHeading,
} from "./vault-read.js";
export {
  VaultDiscoverService,
  type VaultDiscoverServiceOptions,
} from "./vault-discover.js";
export {
  createObsidianSearchDataSource,
  renderRegisteredReference,
  type ObsidianSearchAdapter,
} from "./obsidian-search-data-source.js";
export {
  REGISTERED_REFERENCE_PROFILES,
  SearchSnapshotManager,
  type HostLocation,
  type HostPosition,
  type HostReferenceEvidence,
  type RegisteredReferenceProfile,
  type SearchSnapshot,
  type SearchSnapshotDataSource,
  type SearchSnapshotNote,
  type SearchSnapshotReadiness,
  type SearchSnapshotReference,
  type SearchSnapshotSemanticEvidence,
} from "./search-snapshot.js";
export {
  CONTINUATION_LIFETIME_MILLISECONDS,
  MAXIMUM_ACTIVE_CHAINS_PER_CLIENT,
  MAXIMUM_COMPACT_RESPONSE_BYTES,
  MAXIMUM_RETAINED_BYTES_PER_CLIENT,
  createVaultContinuationStore,
  type VaultContinuationStore,
  type VaultContinuationStoreOptions,
} from "./vault-continuation.js";
export {
  EXPECTED_VAULT_ID_HEADER,
  type RequestPolicyFailure,
  verifyRequestPolicy,
} from "./request-policy.js";
export {
  BRIDGE_VERSION,
  PLUGIN_VERSION,
  PROTOCOL_VERSION,
  SUPPORTED_OBSIDIAN_VERSION,
} from "./version.js";
