import { describe, expect, it, vi } from "vitest";

import {
  ReleaseLifecycleManager,
  type ReleaseLifecycleHost,
  type StagedReleaseBundle,
} from "../src/release-lifecycle.js";

const bundle: StagedReleaseBundle = {
  tag: "v1.2.3",
  version: "1.2.3",
  pluginId: "llm-wiki-vault-bridge",
  bytes: 128,
  files: [
    { path: "manifest.json", sha256: "manifest-sha" },
    { path: "main.js", sha256: "main-sha" },
  ],
};

function lifecycleHost(
  overrides: Partial<ReleaseLifecycleHost> = {},
): ReleaseLifecycleHost {
  return {
    stageRelease: vi.fn(async () => bundle),
    verifyAttestation: vi.fn(async () => true),
    sha256: vi.fn(async (_bundle, path) => `${path === "main.js" ? "main" : "manifest"}-sha`),
    verifyCompatibility: vi.fn(async () => true),
    verifyUpgradePath: vi.fn(async () => true),
    preflightTarget: vi.fn(async () => ({
      vaultExists: true,
      configDirectoryExists: true,
      destinationValid: true,
      availableBytes: 1_024,
    })),
    atomicReplaceReleaseFiles: vi.fn(async () => undefined),
    inspectInstallation: vi.fn(async () => ({
      releaseInstalled: false,
      pluginEnabled: false,
      bridgeReachable: false,
      mcpRegistered: false,
      expectedVaultId: null,
      bridgeVaultId: null,
    })),
    inspectOperationalState: vi.fn(async () => ({
      executing: false,
      queued: 0,
      unresolvedRecovery: false,
    })),
    removeReleaseFiles: vi.fn(async () => undefined),
    localInteractivePurgeConfirmation: vi.fn(async () => false),
    backupOperationalState: vi.fn(async () => undefined),
    purgeOperationalState: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("verified release installation", () => {
  it("rejects a mutable release selector before staging", async () => {
    const host = lifecycleHost();
    const manager = new ReleaseLifecycleManager(host, "llm-wiki-vault-bridge");

    await expect(manager.install("/vault", "latest")).rejects.toThrow(
      "explicit immutable release tag",
    );
    expect(host.stageRelease).not.toHaveBeenCalled();
    expect(host.atomicReplaceReleaseFiles).not.toHaveBeenCalled();
  });

  it("installs only after every release and target verification passes", async () => {
    const host = lifecycleHost();
    const manager = new ReleaseLifecycleManager(host, "llm-wiki-vault-bridge");

    await manager.install("/vault", "v1.2.3");

    expect(host.stageRelease).toHaveBeenCalledWith("v1.2.3");
    expect(host.verifyAttestation).toHaveBeenCalledWith(bundle);
    expect(host.verifyCompatibility).toHaveBeenCalledWith(bundle);
    expect(host.preflightTarget).toHaveBeenCalledWith("/vault", bundle.bytes);
    expect(host.atomicReplaceReleaseFiles).toHaveBeenCalledWith("/vault", bundle);
    expect(vi.mocked(host.atomicReplaceReleaseFiles).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(host.preflightTarget).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each([
    ["release identity", { stageRelease: vi.fn(async () => ({ ...bundle, tag: "v1.2.4" })) }],
    ["plugin identity", { stageRelease: vi.fn(async () => ({ ...bundle, pluginId: "other" })) }],
    ["attestation", { verifyAttestation: vi.fn(async () => false) }],
    ["SHA-256", { sha256: vi.fn(async () => "wrong") }],
    ["compatibility", { verifyCompatibility: vi.fn(async () => false) }],
    ["target Vault", { preflightTarget: vi.fn(async () => ({ vaultExists: false, configDirectoryExists: true, destinationValid: true, availableBytes: 1_024 })) }],
    ["config directory", { preflightTarget: vi.fn(async () => ({ vaultExists: true, configDirectoryExists: false, destinationValid: true, availableBytes: 1_024 })) }],
    ["destination", { preflightTarget: vi.fn(async () => ({ vaultExists: true, configDirectoryExists: true, destinationValid: false, availableBytes: 1_024 })) }],
    ["capacity", { preflightTarget: vi.fn(async () => ({ vaultExists: true, configDirectoryExists: true, destinationValid: true, availableBytes: 127 })) }],
  ])("fails closed when %s verification fails", async (_label, overrides) => {
    const host = lifecycleHost(overrides as Partial<ReleaseLifecycleHost>);
    const manager = new ReleaseLifecycleManager(host, "llm-wiki-vault-bridge");

    await expect(manager.install("/vault", "v1.2.3")).rejects.toThrow();
    expect(host.atomicReplaceReleaseFiles).not.toHaveBeenCalled();
  });

  it("preflights every Vault before replacing any Vault in a batch", async () => {
    const events: string[] = [];
    const host = lifecycleHost({
      preflightTarget: vi.fn(async (vaultPath) => {
        events.push(`preflight:${vaultPath}`);
        return { vaultExists: true, configDirectoryExists: true, destinationValid: true, availableBytes: 1_024 };
      }),
      atomicReplaceReleaseFiles: vi.fn(async (vaultPath) => {
        events.push(`replace:${vaultPath}`);
      }),
    });

    await new ReleaseLifecycleManager(host, "llm-wiki-vault-bridge")
      .installMany(["/vault-a", "/vault-b"], "v1.2.3");

    expect(events).toEqual([
      "preflight:/vault-a",
      "preflight:/vault-b",
      "replace:/vault-a",
      "replace:/vault-b",
    ]);
  });

  it("does not replace any Vault when one batch preflight fails", async () => {
    const host = lifecycleHost({
      preflightTarget: vi.fn(async (vaultPath) => ({
        vaultExists: vaultPath !== "/vault-b",
        configDirectoryExists: true,
        destinationValid: true,
        availableBytes: 1_024,
      })),
    });

    await expect(
      new ReleaseLifecycleManager(host, "llm-wiki-vault-bridge")
        .installMany(["/vault-a", "/vault-b"], "v1.2.3"),
    ).rejects.toThrow("Target Vault");
    expect(host.atomicReplaceReleaseFiles).not.toHaveBeenCalled();
  });
});

describe("lifecycle reporting", () => {
  it.each([
    [{ releaseInstalled: false }, "not_installed"],
    [{ releaseInstalled: true, pluginEnabled: false }, "installed_not_enabled"],
    [{ releaseInstalled: true, pluginEnabled: true, bridgeReachable: false }, "bridge_offline"],
    [{ releaseInstalled: true, pluginEnabled: true, bridgeReachable: true, mcpRegistered: false }, "mcp_not_registered"],
    [{ releaseInstalled: true, pluginEnabled: true, bridgeReachable: true, mcpRegistered: true, expectedVaultId: "vault-a", bridgeVaultId: "vault-b" }, "identity_mismatch"],
    [{ releaseInstalled: true, pluginEnabled: true, bridgeReachable: true, mcpRegistered: true, expectedVaultId: "vault-a", bridgeVaultId: "vault-a" }, "ready"],
  ])("reports %s as %s", async (overrides, expected) => {
    const host = lifecycleHost({
      inspectInstallation: vi.fn(async () => ({
        releaseInstalled: false,
        pluginEnabled: false,
        bridgeReachable: false,
        mcpRegistered: false,
        expectedVaultId: null,
        bridgeVaultId: null,
        ...overrides,
      })),
    });

    await expect(
      new ReleaseLifecycleManager(host, "llm-wiki-vault-bridge").inspect("/vault"),
    ).resolves.toBe(expected);
  });
});

describe("uninstall and purge", () => {
  it("ordinary uninstall removes only release files and returns but does not run the MCP removal command", async () => {
    const mcpRemovalCommand = vi.fn(async () => "claude mcp remove --scope local vault");
    const host = lifecycleHost({ mcpRemovalCommand });

    const result = await new ReleaseLifecycleManager(host, "llm-wiki-vault-bridge")
      .uninstall("/vault");

    expect(host.removeReleaseFiles).toHaveBeenCalledWith(
      "/vault",
      ["manifest.json", "main.js", "styles.css"],
    );
    expect(result).toEqual({ mcpRemovalCommand: "claude mcp remove --scope local vault" });
    expect(host.purgeOperationalState).not.toHaveBeenCalled();
  });

  it.each([
    ["executing Change Set", { executing: true, queued: 0, unresolvedRecovery: false }],
    ["queued work", { executing: false, queued: 1, unresolvedRecovery: false }],
    ["unresolved recovery", { executing: false, queued: 0, unresolvedRecovery: true }],
  ])("rejects ordinary uninstall with %s", async (_label, state) => {
    const host = lifecycleHost({ inspectOperationalState: vi.fn(async () => state) });

    await expect(
      new ReleaseLifecycleManager(host, "llm-wiki-vault-bridge").uninstall("/vault"),
    ).rejects.toThrow();
    expect(host.removeReleaseFiles).not.toHaveBeenCalled();
  });

  it("purges operational state only after local confirmation and a successful backup", async () => {
    const events: string[] = [];
    const host = lifecycleHost({
      localInteractivePurgeConfirmation: vi.fn(async () => {
        events.push("confirm");
        return true;
      }),
      backupOperationalState: vi.fn(async () => { events.push("backup"); }),
      purgeOperationalState: vi.fn(async () => { events.push("purge"); }),
    });

    await new ReleaseLifecycleManager(host, "llm-wiki-vault-bridge").purge("/vault");

    expect(events).toEqual(["confirm", "backup", "purge"]);
    expect(host.removeReleaseFiles).not.toHaveBeenCalled();
  });

  it("defaults purge to denied without local interactive confirmation", async () => {
    const host = lifecycleHost();

    await expect(
      new ReleaseLifecycleManager(host, "llm-wiki-vault-bridge").purge("/vault"),
    ).rejects.toThrow("local interactive confirmation");
    expect(host.backupOperationalState).not.toHaveBeenCalled();
    expect(host.purgeOperationalState).not.toHaveBeenCalled();
  });

  it("does not purge when backup fails or recovery is unresolved", async () => {
    const backupFailure = lifecycleHost({
      localInteractivePurgeConfirmation: vi.fn(async () => true),
      backupOperationalState: vi.fn(async () => { throw new Error("backup failed"); }),
    });
    await expect(
      new ReleaseLifecycleManager(backupFailure, "llm-wiki-vault-bridge").purge("/vault"),
    ).rejects.toThrow("backup failed");
    expect(backupFailure.purgeOperationalState).not.toHaveBeenCalled();

    const unresolved = lifecycleHost({
      inspectOperationalState: vi.fn(async () => ({ executing: false, queued: 0, unresolvedRecovery: true })),
      localInteractivePurgeConfirmation: vi.fn(async () => true),
    });
    await expect(
      new ReleaseLifecycleManager(unresolved, "llm-wiki-vault-bridge").purge("/vault"),
    ).rejects.toThrow("recovery is unresolved");
    expect(unresolved.localInteractivePurgeConfirmation).not.toHaveBeenCalled();
    expect(unresolved.purgeOperationalState).not.toHaveBeenCalled();
  });
});

describe("repair and upgrade", () => {
  it("repairs only release-managed files without inspecting or purging operational state", async () => {
    const host = lifecycleHost();

    await new ReleaseLifecycleManager(host, "llm-wiki-vault-bridge")
      .repair("/vault", "v1.2.3");

    expect(host.atomicReplaceReleaseFiles).toHaveBeenCalledWith("/vault", bundle);
    expect(host.inspectOperationalState).not.toHaveBeenCalled();
    expect(host.purgeOperationalState).not.toHaveBeenCalled();
  });

  it("performs replacement inside runtime maintenance and leaves resume to the runtime", async () => {
    const events: string[] = [];
    const host = lifecycleHost({
      atomicReplaceReleaseFiles: vi.fn(async () => { events.push("replace"); }),
    });
    const runtime = {
      runOperatorMaintenance: vi.fn(async (replace: () => Promise<void> | void) => {
        events.push("maintenance:start");
        await replace();
        events.push("maintenance:paused");
      }),
    };

    await new ReleaseLifecycleManager(host, "llm-wiki-vault-bridge")
      .upgrade("/vault", "v1.2.3", runtime);

    expect(events).toEqual(["maintenance:start", "replace", "maintenance:paused"]);
    expect(runtime.runOperatorMaintenance).toHaveBeenCalledOnce();
  });

  it("never enters maintenance when release verification fails", async () => {
    const host = lifecycleHost({ verifyAttestation: vi.fn(async () => false) });
    const runtime = { runOperatorMaintenance: vi.fn(async () => undefined) };

    await expect(
      new ReleaseLifecycleManager(host, "llm-wiki-vault-bridge")
        .upgrade("/vault", "v1.2.3", runtime),
    ).rejects.toThrow("attestation");
    expect(runtime.runOperatorMaintenance).not.toHaveBeenCalled();
  });

  it("blocks a downgrade or incompatible migration before entering maintenance", async () => {
    const host = lifecycleHost({ verifyUpgradePath: vi.fn(async () => false) });
    const runtime = { runOperatorMaintenance: vi.fn(async () => undefined) };

    await expect(
      new ReleaseLifecycleManager(host, "llm-wiki-vault-bridge")
        .upgrade("/vault", "v1.2.3", runtime),
    ).rejects.toThrow("safe migration path");
    expect(host.verifyUpgradePath).toHaveBeenCalledWith("/vault", bundle);
    expect(runtime.runOperatorMaintenance).not.toHaveBeenCalled();
    expect(host.atomicReplaceReleaseFiles).not.toHaveBeenCalled();
  });
});
