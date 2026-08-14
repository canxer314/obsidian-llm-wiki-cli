export const RELEASE_MANAGED_FILES = ["manifest.json", "main.js", "styles.css"] as const;

export interface StagedReleaseFile {
  path: string;
  sha256: string;
}

export interface StagedReleaseBundle {
  tag: string;
  version: string;
  pluginId: string;
  bytes: number;
  files: readonly StagedReleaseFile[];
}

export interface InstallationInspection {
  releaseInstalled: boolean;
  pluginEnabled: boolean;
  bridgeReachable: boolean;
  mcpRegistered: boolean;
  expectedVaultId: string | null;
  bridgeVaultId: string | null;
}

export interface OperationalStateInspection {
  executing: boolean;
  queued: number;
  unresolvedRecovery: boolean;
}

export interface ReleaseTargetPreflight {
  vaultExists: boolean;
  configDirectoryExists: boolean;
  destinationValid: boolean;
  availableBytes: number;
}

export interface ReleaseLifecycleHost {
  stageRelease(tag: string): Promise<StagedReleaseBundle>;
  verifyAttestation(bundle: StagedReleaseBundle): Promise<boolean>;
  sha256(bundle: StagedReleaseBundle, path: string): Promise<string>;
  verifyCompatibility(bundle: StagedReleaseBundle): Promise<boolean>;
  verifyUpgradePath(vaultPath: string, bundle: StagedReleaseBundle): Promise<boolean>;
  preflightTarget(vaultPath: string, requiredBytes: number): Promise<ReleaseTargetPreflight>;
  atomicReplaceReleaseFiles(vaultPath: string, bundle: StagedReleaseBundle): Promise<void>;
  inspectInstallation(vaultPath: string): Promise<InstallationInspection>;
  inspectOperationalState(vaultPath: string): Promise<OperationalStateInspection>;
  removeReleaseFiles(vaultPath: string, files: readonly string[]): Promise<void>;
  localInteractivePurgeConfirmation(vaultPath: string): Promise<boolean>;
  backupOperationalState(vaultPath: string): Promise<void>;
  purgeOperationalState(vaultPath: string): Promise<void>;
  mcpRemovalCommand?(vaultPath: string): Promise<string> | string;
}

export interface OperatorMaintenanceRuntime {
  runOperatorMaintenance(replaceValidatedBundle: () => void | Promise<void>): Promise<void>;
}

export type InstallationLifecycleState =
  | "not_installed"
  | "installed_not_enabled"
  | "bridge_offline"
  | "mcp_not_registered"
  | "identity_mismatch"
  | "ready";

export interface UninstallResult {
  mcpRemovalCommand: string | null;
}

function assertImmutableTag(tag: string): void {
  if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error("An explicit immutable release tag is required");
  }
}

function versionFromTag(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

export class ReleaseLifecycleManager {
  constructor(
    private readonly host: ReleaseLifecycleHost,
    private readonly expectedPluginId: string,
  ) {}

  async install(vaultPath: string, tag: string): Promise<void> {
    const bundle = await this.prepare(vaultPath, tag);
    await this.host.atomicReplaceReleaseFiles(vaultPath, bundle);
  }

  async installMany(vaultPaths: readonly string[], tag: string): Promise<void> {
    assertImmutableTag(tag);
    const bundle = await this.verifyRelease(tag);
    for (const vaultPath of vaultPaths) await this.preflight(vaultPath, bundle);
    for (const vaultPath of vaultPaths) {
      await this.host.atomicReplaceReleaseFiles(vaultPath, bundle);
    }
  }

  async repair(vaultPath: string, tag: string): Promise<void> {
    await this.install(vaultPath, tag);
  }

  async upgrade(
    vaultPath: string,
    tag: string,
    runtime: OperatorMaintenanceRuntime,
  ): Promise<void> {
    const bundle = await this.prepare(vaultPath, tag);
    if (!(await this.host.verifyUpgradePath(vaultPath, bundle))) {
      throw new Error("Release has no safe migration path from the installed state");
    }
    await runtime.runOperatorMaintenance(() =>
      this.host.atomicReplaceReleaseFiles(vaultPath, bundle),
    );
  }

  async inspect(vaultPath: string): Promise<InstallationLifecycleState> {
    const state = await this.host.inspectInstallation(vaultPath);
    if (!state.releaseInstalled) return "not_installed";
    if (!state.pluginEnabled) return "installed_not_enabled";
    if (!state.bridgeReachable) return "bridge_offline";
    if (!state.mcpRegistered) return "mcp_not_registered";
    if (
      state.expectedVaultId === null ||
      state.bridgeVaultId === null ||
      state.expectedVaultId !== state.bridgeVaultId
    ) return "identity_mismatch";
    return "ready";
  }

  async uninstall(vaultPath: string): Promise<UninstallResult> {
    const state = await this.host.inspectOperationalState(vaultPath);
    if (state.executing) throw new Error("Cannot uninstall while a Change Set is executing");
    if (state.queued > 0) throw new Error("Cannot uninstall while work is queued");
    if (state.unresolvedRecovery) {
      throw new Error("Cannot uninstall while recovery is unresolved");
    }
    await this.host.removeReleaseFiles(vaultPath, RELEASE_MANAGED_FILES);
    return {
      mcpRemovalCommand: this.host.mcpRemovalCommand === undefined
        ? null
        : await this.host.mcpRemovalCommand(vaultPath),
    };
  }

  async purge(vaultPath: string): Promise<void> {
    const state = await this.host.inspectOperationalState(vaultPath);
    if (state.unresolvedRecovery) {
      throw new Error("Cannot purge while recovery is unresolved");
    }
    if (!(await this.host.localInteractivePurgeConfirmation(vaultPath))) {
      throw new Error("Purge requires local interactive confirmation");
    }
    await this.host.backupOperationalState(vaultPath);
    await this.host.purgeOperationalState(vaultPath);
  }

  private async prepare(vaultPath: string, tag: string): Promise<StagedReleaseBundle> {
    assertImmutableTag(tag);
    const bundle = await this.verifyRelease(tag);
    await this.preflight(vaultPath, bundle);
    return bundle;
  }

  private async verifyRelease(tag: string): Promise<StagedReleaseBundle> {
    const bundle = await this.host.stageRelease(tag);
    if (bundle.tag !== tag || bundle.version !== versionFromTag(tag)) {
      throw new Error("Release identity does not match the requested immutable tag");
    }
    if (bundle.pluginId !== this.expectedPluginId) {
      throw new Error("Release identity does not match the expected plugin");
    }
    if (!(await this.host.verifyAttestation(bundle))) {
      throw new Error("Release attestation verification failed");
    }
    const paths = new Set(bundle.files.map(({ path }) => path));
    if (!paths.has("manifest.json") || !paths.has("main.js")) {
      throw new Error("Release bundle is missing required files");
    }
    for (const file of bundle.files) {
      if (!RELEASE_MANAGED_FILES.includes(file.path as (typeof RELEASE_MANAGED_FILES)[number])) {
        throw new Error(`Release bundle contains unmanaged file: ${file.path}`);
      }
      if ((await this.host.sha256(bundle, file.path)) !== file.sha256) {
        throw new Error(`SHA-256 verification failed for ${file.path}`);
      }
    }
    if (!(await this.host.verifyCompatibility(bundle))) {
      throw new Error("Release is incompatible with this Obsidian runtime");
    }
    return bundle;
  }

  private async preflight(vaultPath: string, bundle: StagedReleaseBundle): Promise<void> {
    const target = await this.host.preflightTarget(vaultPath, bundle.bytes);
    if (!target.vaultExists) throw new Error("Target Vault does not exist");
    if (!target.configDirectoryExists) throw new Error("Vault config directory does not exist");
    if (!target.destinationValid) throw new Error("Release destination is invalid");
    if (target.availableBytes < bundle.bytes) throw new Error("Insufficient disk capacity");
  }
}
