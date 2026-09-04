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
  RECOVERY_JOURNAL_FRAME_SCHEMA_VERSION,
  ChangeSetService,
  fingerprintChangeSetRequest,
  type BoundMoveDerivedEffect,
  type BoundMoveProjection,
  type FrontmatterChange,
  type MoveDerivedProjection,
  type MoveProjection,
  type MoveSnapshotBarrier,
  type ChangeSetExecutionAdapter,
  type ChangeSetExecutionState,
  type ChangeSetRuntimeStatePort,
  type ChangeSetWriteMode,
  type RecoveryJournalFrame,
  type RecoveryFileFootprint,
  type RecoveryFileState,
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
  CHANGE_SET_SEMANTIC_EVIDENCE_DEADLINE_MS,
  createChangeSetSemanticEvidenceTracker,
  createFileSystemChangeSetExecutionAdapter,
  createNodeFileSystemChangeSetHost,
  type ChangeSetExecutionHost,
  type ChangeSetSemanticEvidenceTracker,
  type ChangeSetSemanticEvidenceTrackerOptions,
  type ChangeSetSemanticProbes,
  type DirectoryExecutionHost,
  type FileSystemChangeSetExecutionAdapter,
  type FileSystemChangeSetExecutionOptions,
  type NodeFileSystemChangeSetHostOptions,
} from "./file-system-change-set-execution.js";
export {
  STANDARD_DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
  STANDARD_DIAGNOSTIC_BUNDLE_VERSION,
  canonicalizeDiagnosticPayload,
  createStandardDiagnosticBundle,
  verifyStandardDiagnosticBundle,
  type StandardDiagnosticBundle,
  type StandardDiagnosticBundleContent,
  type StandardDiagnosticEvidence,
} from "./diagnostic-bundle.js";
export { createRegistrationCommand } from "./registration-command.js";
export {
  createMoveReferenceProjector,
  withMoveReferenceProjection,
  type MoveReferenceSnapshotSource,
} from "./move-reference-projection.js";
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
  RUN_MAINTENANCE_COMMAND_ID,
  assertValidatedInstalledBundle,
  registerRunMaintenanceCommand,
  type InstalledBundleProbe,
  type MaintenanceCommandRegistry,
} from "./maintenance-operation.js";
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
  CANDIDATE_CHECKSUM_MANIFEST,
  CANDIDATE_OPTIONAL_FILES,
  CANDIDATE_REQUIRED_FILES,
  CandidateBundleError,
  inspectCandidateBundle,
  installCandidateBundle,
  type CandidateBundleIdentity,
  type CandidateFileDigest,
  type CandidateManagedFile,
  type InstalledCandidate,
} from "./installed-runtime/candidate-bundle.js";
export {
  EvidencePrivacyError,
  EvidenceWriteError,
  installedRuntimeEvidenceSchema,
  parseEvidence,
  serializeEvidence,
  writeEvidenceFile,
  type InstalledRuntimeEvidence,
  type InstalledRuntimeVerdict,
} from "./installed-runtime/evidence.js";
export {
  runInstalledRuntimeHarness,
  type HarnessFailure,
  type HarnessFailureCode,
  type HarnessStage,
  type HarnessTimeouts,
  type InstalledRuntimeHarnessOptions,
  type InstalledRuntimeHarnessResult,
} from "./installed-runtime/harness.js";
export {
  createLoopbackMcpClient,
  HealthObservationError,
  type BridgeHealthObservation,
  type HealthObservationFailureCode,
  type LoopbackMcpClient,
  type LoopbackMcpClientOptions,
  type ObservedHealth,
} from "./installed-runtime/loopback-client.js";
export {
  BridgeIdentityError,
  createWindowsObsidianProcessControl,
  ObsidianProcessError,
  ReadinessTimeoutError,
  readPersistedBridgeIdentity,
  waitForCondition,
  type ObsidianLaunchRequest,
  type ObsidianProcessControl,
  type ObsidianProcessHandle,
  type PersistedBridgeIdentity,
  type ReadinessWaitOptions,
} from "./installed-runtime/obsidian-process.js";
export {
  hostOsBuild,
  lookupRegisteredRuntimeProfile,
  MVP_PERF_REF_1,
  preflightRuntimeProfile,
  registeredRuntimeProfiles,
  type ObservedRuntimeEnvironment,
  type RegisteredRuntimeProfile,
  type RuntimeEnvironmentProbe,
  type RuntimePreflightMismatch,
  type RuntimeVersionExpectation,
} from "./installed-runtime/runtime-profile.js";
export {
  cleanupTestVault,
  compareInventories,
  provisionTestVault,
  snapshotInventory,
  TestVaultError,
  TEST_PROFILE_DIRECTORY_PREFIX,
  TEST_VAULT_DIRECTORY_PREFIX,
  type CleanupReport,
  type InventoryComparison,
  type ProvisionedTestVault,
  type VaultInventoryEntry,
} from "./installed-runtime/test-vault.js";
export {
  BRIDGE_VERSION,
  PLUGIN_VERSION,
  PROTOCOL_VERSION,
  SUPPORTED_OBSIDIAN_VERSION,
} from "./version.js";
