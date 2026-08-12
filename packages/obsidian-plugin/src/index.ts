export {
  createBridgeInstance,
  type BridgeDiscoverService,
  type BridgeHealthState,
  type BridgeInstance,
  type BridgeInstanceOptions,
  type BridgeRequestAuthenticator,
  type ProtocolParticipant,
} from "./bridge-instance.js";
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
  SearchSnapshotManager,
  type SearchSnapshot,
  type SearchSnapshotDataSource,
  type SearchSnapshotNote,
  type SearchSnapshotReadiness,
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
