import { describe, expect, it, vi } from "vitest";

import {
  RUN_MAINTENANCE_COMMAND_ID,
  assertValidatedInstalledBundle,
  registerRunMaintenanceCommand,
  type InstalledBundleProbe,
} from "../src/maintenance-operation.js";
import { PLUGIN_VERSION } from "../src/version.js";

function bundleProbe(overrides: Partial<InstalledBundleProbe> = {}): InstalledBundleProbe {
  return {
    readManifest: async () => ({ id: "llm-wiki-vault-bridge", version: PLUGIN_VERSION }),
    hasEntryPoint: async () => true,
    ...overrides,
  };
}

describe("validated installed bundle", () => {
  it("accepts the bundle whose manifest matches the running plugin", async () => {
    await expect(
      assertValidatedInstalledBundle(bundleProbe(), "llm-wiki-vault-bridge"),
    ).resolves.toBeUndefined();
  });

  it("rejects when the manifest cannot be read", async () => {
    const probe = bundleProbe({
      readManifest: async () => {
        throw new Error("ENOENT");
      },
    });
    await expect(assertValidatedInstalledBundle(probe, "llm-wiki-vault-bridge"))
      .rejects.toThrow("manifest.json is unreadable");
  });

  it.each([null, "not-an-object", [1, 2, 3]])(
    "rejects a manifest that is not an object: %j",
    async (manifest) => {
      const probe = bundleProbe({ readManifest: async () => manifest });
      await expect(assertValidatedInstalledBundle(probe, "llm-wiki-vault-bridge"))
        .rejects.toThrow("manifest.json is not an object");
    },
  );

  it("rejects a bundle identity that differs from the running plugin", async () => {
    const probe = bundleProbe({
      readManifest: async () => ({ id: "other-plugin", version: PLUGIN_VERSION }),
    });
    await expect(assertValidatedInstalledBundle(probe, "llm-wiki-vault-bridge"))
      .rejects.toThrow("identity does not match");
  });

  it("rejects a torn replacement whose version differs from the running plugin", async () => {
    const probe = bundleProbe({
      readManifest: async () => ({ id: "llm-wiki-vault-bridge", version: "0.0.0" }),
    });
    await expect(assertValidatedInstalledBundle(probe, "llm-wiki-vault-bridge"))
      .rejects.toThrow("version does not match");
  });

  it("rejects a bundle whose entry point is missing", async () => {
    const probe = bundleProbe({ hasEntryPoint: async () => false });
    await expect(assertValidatedInstalledBundle(probe, "llm-wiki-vault-bridge"))
      .rejects.toThrow("main.js is missing");
  });
});

describe("Run Managed Vault maintenance command", () => {
  it("registers one command that triggers the maintenance run", async () => {
    const commands: { id: string; name: string; callback: () => unknown }[] = [];
    const run = vi.fn(async () => undefined);

    registerRunMaintenanceCommand(
      { addCommand: (command) => commands.push(command) },
      run,
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]?.id).toBe("run-managed-vault-maintenance");
    expect(RUN_MAINTENANCE_COMMAND_ID).toBe(commands[0]?.id);
    expect(commands[0]?.name).toBe("Run Managed Vault maintenance");
    expect(run).not.toHaveBeenCalled();
    await commands[0]?.callback();
    expect(run).toHaveBeenCalledOnce();
  });

  it("propagates a failed maintenance run to the command caller", async () => {
    const commands: { id: string; name: string; callback: () => unknown }[] = [];
    registerRunMaintenanceCommand(
      { addCommand: (command) => commands.push(command) },
      async () => {
        throw new Error("migration failed");
      },
    );

    await expect(commands[0]?.callback()).rejects.toThrow("migration failed");
  });
});
