import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { assembleReleaseBundle } from "../src/release/assemble-release-bundle.js";
import { verifyReleaseBundle } from "../src/release/verify-release-bundle.js";
import { provisionTestVault, cleanupTestVault } from "../src/installed-runtime/test-vault.js";

import {
  activateInstalledRuntimeAcceptanceDriver,
  createAuthoritativeInstalledRuntimeRunners,
  createInstalledRuntimeAcceptanceDescriptor,
  loadInstalledRuntimeAcceptanceDescriptor,
  requestInstalledSemanticEvidenceScenario,
  parseInstalledRuntimeSmokeArguments,
  resolveInstalledRuntimePreviousRelease,
} from "../src/installed-runtime/smoke-command.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("installed-runtime authoritative command", () => {
  it("accepts the documented command without an external acceptance-runner module", () => {
    expect(
      parseInstalledRuntimeSmokeArguments([
        "--registration",
        "registration.json",
        "--workdir",
        "runtime-work",
      ]),
    ).toMatchObject({
      registration: "registration.json",
      workdir: "runtime-work",
      profile: "MVP-PERF-REF-1",
    });
  });

  it("accepts a previous release pinned to an immutable tag", () => {
    expect(
      parseInstalledRuntimeSmokeArguments([
        "--previous-release", "releases/v0.0.1",
        "--previous-release-tag", "v0.0.1",
        "--previous-release-attestation", "releases/v0.0.1.attestation.json",
      ]),
    ).toMatchObject({
      previousRelease: "releases/v0.0.1",
      previousReleaseTag: "v0.0.1",
      previousReleaseAttestation: "releases/v0.0.1.attestation.json",
    });
  });

  it("rejects incomplete or mutable previous-release selectors", () => {
    for (const argv of [
      ["--previous-release"],
      ["--previous-release", "--previous-release-tag", "v0.2.0"],
      ["--previous-release", "bundle"],
      ["--previous-release-tag", "v0.2.0"],
      ["--previous-release-attestation", "claims.json"],
      ["--previous-release", "bundle", "--previous-release-tag", "latest"],
    ]) {
      expect(() => parseInstalledRuntimeSmokeArguments(argv)).toThrow();
    }
  });

  it("refuses lifecycle evidence without a pinned previous release", async () => {
    await expect(resolveInstalledRuntimePreviousRelease({
      arguments: { profile: "MVP-PERF-REF-1" },
      candidateVersion: "0.3.0",
      obsidianVersion: "1.13.4",
    })).rejects.toThrow("Previous release directory and immutable tag are required");
  });

  it("verifies a pinned lower-version release without rebuilding its bytes", async () => {
    // Synthetic artifacts exercise the verifier only, not installed provenance.
    const root = await mkdtemp(join(tmpdir(), "previous-release-input-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const packageRoot = join(root, "pkg");
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await writeFile(join(packageRoot, "manifest.json"), JSON.stringify({
      id: "llm-wiki-vault-bridge", name: "Verifier fixture",
      version: "0.2.0", minAppVersion: "1.13.4", isDesktopOnly: true,
    }));
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ version: "0.2.0" }));
    await writeFile(join(packageRoot, "dist", "main.js"), "// verifier fixture\n");
    const bundleDirectory = join(root, "bundle");
    await assembleReleaseBundle({ tag: "v0.2.0", packageRoot, bundleDirectory });
    const release = await resolveInstalledRuntimePreviousRelease({
      arguments: {
        profile: "MVP-PERF-REF-1",
        previousRelease: bundleDirectory,
        previousReleaseTag: "v0.2.0",
      },
      candidateVersion: "0.3.0",
      obsidianVersion: "1.13.4",
    });
    expect(release.identity.pluginVersion).toBe("0.2.0");
    expect(release.tag).toBe("v0.2.0");
    expect(await readFile(join(bundleDirectory, "main.js"), "utf8"))
      .toBe("// verifier fixture\n");
    for (const candidateVersion of ["0.2.0", "0.1.0"]) {
      await expect(resolveInstalledRuntimePreviousRelease({
        arguments: {
          profile: "MVP-PERF-REF-1",
          previousRelease: bundleDirectory,
          previousReleaseTag: "v0.2.0",
        },
        candidateVersion,
        obsidianVersion: "1.13.4",
      })).rejects.toThrow("Previous release must be older than the candidate");
    }
    await writeFile(join(bundleDirectory, "main.js"), "// tampered release\n");
    await expect(resolveInstalledRuntimePreviousRelease({
      arguments: {
        profile: "MVP-PERF-REF-1",
        previousRelease: bundleDirectory,
        previousReleaseTag: "v0.2.0",
      },
      candidateVersion: "0.3.0",
      obsidianVersion: "1.13.4",
    })).rejects.toThrow();
  });

  it("composes every required release-blocking runner in the installed command", () => {
    const runners = createAuthoritativeInstalledRuntimeRunners();
    expect(Object.keys(runners).sort()).toEqual([
      "isolateSemanticEvidenceScenarios",
      "prepareInstalledRuntimeAcceptanceDriver",
      "runGateIsolationCorpus",
      "runPrivacyRecoveryAuthorityCorpus",
      "runRegisteredReferenceRewriteCorpus",
      "runReleaseLifecycleCorpus",
      "semanticEvidenceScenarioRunner",
    ]);
    for (const runner of Object.values(runners)) {
      expect(
        typeof runner === "boolean" ||
          typeof runner === "function" ||
          typeof runner.run === "function",
      ).toBe(true);
    }
    expect(runners.isolateSemanticEvidenceScenarios).toBe(true);
  });

  it("checks lifecycle release inputs before attempting installed operator control", async () => {
    const runners = createAuthoritativeInstalledRuntimeRunners();
    await expect(runners.runReleaseLifecycleCorpus({
      candidate: { identity: { pluginVersion: "0.3.0" } },
    } as never)).rejects.toThrow("Previous release directory and immutable tag are required");
  });

  it("provisions the built-in installed registered-reference runner", async () => {
    const runners = createAuthoritativeInstalledRuntimeRunners();
    const provisionAttempt = new Error("registered-reference provision attempted");

    await expect(
      runners.runRegisteredReferenceRewriteCorpus({
        runId: "run-123",
        workingDirectory: ".",
        candidate: {} as never,
        processControl: {} as never,
        client: {} as never,
        configDirectoryName: ".obsidian",
        timeouts: { startupMs: 1, stopMs: 1, portClosedMs: 1 },
        provisionVault: async () => {
          throw provisionAttempt;
        },
        cleanupVault: async () => ({ attempted: true, residualPaths: [] }),
        record: () => undefined,
        assertion: () => undefined,
      }),
    ).rejects.toBe(provisionAttempt);
  });

  it("preserves the generated Vault when registered-reference process shutdown fails", async () => {
    // This proves cleanup orchestration, not installed-runtime authority.
    const root = await mkdtemp(join(tmpdir(), "reference-shutdown-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const packageRoot = join(root, "pkg");
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await writeFile(join(packageRoot, "manifest.json"), JSON.stringify({
      id: "llm-wiki-vault-bridge", name: "Verifier fixture",
      version: "0.2.0", minAppVersion: "1.13.4", isDesktopOnly: true,
    }));
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ version: "0.2.0" }));
    await writeFile(join(packageRoot, "dist", "main.js"), "// verifier fixture\n");
    const bundleDirectory = join(root, "bundle");
    await assembleReleaseBundle({ tag: "v0.2.0", packageRoot, bundleDirectory });
    const candidate = await verifyReleaseBundle({ bundleDirectory, expectedTag: "v0.2.0" });
    const shutdownError = new Error("process tree did not exit");
    let cleanupCalls = 0;
    await expect(createAuthoritativeInstalledRuntimeRunners().runRegisteredReferenceRewriteCorpus({
      runId: "shutdown-proof",
      workingDirectory: root,
      candidate,
      processControl: {
        start: async ({ vaultPath }) => {
          await writeFile(join(vaultPath, ".obsidian", "plugins", candidate.identity.pluginId, "data.json"),
            JSON.stringify({ vaultId: "fixture-vault", port: 23456 }));
          return { pid: 123, stop: async () => { throw shutdownError; } };
        },
      },
      client: { observeHealth: async () => { throw new Error("startup failed"); } } as never,
      configDirectoryName: ".obsidian",
      timeouts: { startupMs: 1, stopMs: 1, portClosedMs: 1 },
      provisionVault: provisionTestVault,
      cleanupVault: async (vault) => {
        cleanupCalls += 1;
        return cleanupTestVault(vault);
      },
      record: () => undefined,
      assertion: () => undefined,
    })).rejects.toBe(shutdownError);
    expect(cleanupCalls).toBe(0);
  });

  it("preserves the generated Vault if its listener survives a successful stop", async () => {
    const root = await mkdtemp(join(tmpdir(), "reference-listener-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve, reject) =>
      server.close((error) => error === undefined ? resolve() : reject(error))));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Listener fixture failed");
    const packageRoot = join(root, "pkg");
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await writeFile(join(packageRoot, "manifest.json"), JSON.stringify({
      id: "llm-wiki-vault-bridge", name: "Verifier fixture",
      version: "0.2.0", minAppVersion: "1.13.4", isDesktopOnly: true,
    }));
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ version: "0.2.0" }));
    await writeFile(join(packageRoot, "dist", "main.js"), "// verifier fixture\n");
    const bundleDirectory = join(root, "bundle");
    await assembleReleaseBundle({ tag: "v0.2.0", packageRoot, bundleDirectory });
    const candidate = await verifyReleaseBundle({ bundleDirectory, expectedTag: "v0.2.0" });
    let cleanupCalls = 0;
    await expect(createAuthoritativeInstalledRuntimeRunners().runRegisteredReferenceRewriteCorpus({
      runId: "listener-proof", workingDirectory: root, candidate,
      processControl: {
        start: async ({ vaultPath }) => {
          await writeFile(join(vaultPath, ".obsidian", "plugins", candidate.identity.pluginId, "data.json"),
            JSON.stringify({ schemaVersion: 2, vaultId: "fixture-vault", port: address.port }));
          return { pid: 123, stop: async () => undefined };
        },
      },
      client: { observeHealth: async () => { throw new Error("startup failed"); } } as never,
      configDirectoryName: ".obsidian",
      timeouts: { startupMs: 1, stopMs: 1, portClosedMs: 1 },
      provisionVault: provisionTestVault,
      cleanupVault: async (vault) => { cleanupCalls += 1; return cleanupTestVault(vault); },
      record: () => undefined, assertion: () => undefined,
    })).rejects.toThrow("listener survived");
    expect(cleanupCalls).toBe(0);
  });

  it("writes a run-bound private descriptor only inside the generated Vault", async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), "installed-smoke-command-"));
    cleanups.push(() => rm(workingDirectory, { recursive: true, force: true }));
    const vaultPath = join(workingDirectory, "installed-runtime-vault-run-123");
    const reportDirectory = join(workingDirectory, "installed-runtime-acceptance-run-123");
    await mkdir(join(vaultPath, ".obsidian", "plugins", "llm-wiki"), {
      recursive: true,
    });
    await writeFile(
      join(vaultPath, ".obsidian", "plugins", "llm-wiki", "main.js"),
      "installed candidate\n",
      "utf8",
    );

    const descriptor = await createInstalledRuntimeAcceptanceDescriptor({
      runId: "run-123",
      vaultPath,
      pluginId: "llm-wiki",
      candidateBundleSha256: "a".repeat(64),
      reportDirectory,
      createCapabilityToken: () => "b".repeat(64),
    });

    expect(
      JSON.parse(await readFile(descriptor.path, "utf8")),
    ).toEqual({
      schemaVersion: 1,
      runId: "run-123",
      vaultPath,
      pluginId: "llm-wiki",
      candidateBundleSha256: "a".repeat(64),
      installedMainSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      reportDirectory,
      capabilityToken: "b".repeat(64),
      command: {
        sequence: 0,
        capabilityToken: "b".repeat(64),
        action: "idle",
      },
    });
    expect(descriptor.path.startsWith(`${vaultPath}/.obsidian/plugins/llm-wiki/`)).toBe(true);
  });

  it("loads the descriptor only when Vault and installed candidate bytes still match", async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), "installed-smoke-command-"));
    cleanups.push(() => rm(workingDirectory, { recursive: true, force: true }));
    const vaultPath = join(workingDirectory, "installed-runtime-vault-run-123");
    const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "llm-wiki");
    const mainPath = join(pluginDirectory, "main.js");
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(mainPath, "installed candidate\n", "utf8");
    await createInstalledRuntimeAcceptanceDescriptor({
      runId: "run-123",
      vaultPath,
      pluginId: "llm-wiki",
      candidateBundleSha256: "a".repeat(64),
      reportDirectory: join(workingDirectory, "installed-runtime-acceptance-run-123"),
      createCapabilityToken: () => "b".repeat(64),
    });

    await expect(
      loadInstalledRuntimeAcceptanceDescriptor({ vaultPath, pluginId: "llm-wiki" }),
    ).resolves.toMatchObject({ runId: "run-123", vaultPath });

    await writeFile(mainPath, "tampered candidate\n", "utf8");
    await expect(
      loadInstalledRuntimeAcceptanceDescriptor({ vaultPath, pluginId: "llm-wiki" }),
    ).rejects.toThrow(/installed entry point/u);
  });

  it("activates private control only for a matching installed candidate", async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), "installed-smoke-command-"));
    cleanups.push(() => rm(workingDirectory, { recursive: true, force: true }));
    const vaultPath = join(workingDirectory, "installed-runtime-vault-run-123");
    const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "llm-wiki");
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(join(pluginDirectory, "main.js"), "installed candidate\n", "utf8");
    await createInstalledRuntimeAcceptanceDescriptor({
      runId: "run-123",
      vaultPath,
      pluginId: "llm-wiki",
      candidateBundleSha256: "a".repeat(64),
      reportDirectory: join(workingDirectory, "installed-runtime-acceptance-run-123"),
      createCapabilityToken: () => "b".repeat(64),
    });

    const commands: string[] = [];
    const summary = {
      scenario: "create_note/clean_convergence",
      source: "installed-obsidian",
      mutationKind: "create_note",
      proofState: "intent_applied",
      statusProofState: "intent_applied",
      journalPhase: "COMMITTED",
      evidenceDeadlineMs: 5_000,
      successBarrierDeadlineMs: 5_000,
      evidenceSessions: [
        { mode: "apply", outcome: "converged", virtualElapsedMs: 250 },
      ],
      quietWindowResets: 0,
      acceptedSnapshotRounds: 1,
      rejectedSnapshotRounds: 0,
      successorSnapshot: {
        baselineVersion: 1,
        version: 2,
        immutable: true,
        publishedBeforeIntentApplied: true,
      },
      durableCommitBeforeIntentApplied: true,
      writesBlocked: false,
      beforeInventorySha256: "c".repeat(64),
      afterInventorySha256: "d".repeat(64),
      cleanupSucceeded: true,
    } as const;
    const activation = await activateInstalledRuntimeAcceptanceDriver({
      vaultPath,
      pluginId: "llm-wiki",
      executeSemanticEvidenceScenario: async ({ scenario }) => {
        commands.push(scenario);
        return summary;
      },
    });

    expect(activation?.descriptor).toMatchObject({
      runId: "run-123",
      vaultPath,
      pluginId: "llm-wiki",
    });
    await requestInstalledSemanticEvidenceScenario({
      descriptorPath: join(
        pluginDirectory,
        "installed-runtime-acceptance.json",
      ),
      descriptor: activation!.descriptor,
      scenario: "create_note/clean_convergence",
      expectedVaultId: "vault-123",
      endpoint: new URL("http://127.0.0.1:32123/mcp"),
    });
    await expect.poll(() => commands).toEqual([
      "create_note/clean_convergence",
    ]);
    const reportPath = join(
      workingDirectory,
      "installed-runtime-acceptance-run-123",
      "semantic-evidence-create_note_clean_convergence.json",
    );
    expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({
      runId: "run-123",
      vaultId: "vault-123",
      candidateBundleSha256: "a".repeat(64),
      capabilityToken: "b".repeat(64),
      summary,
    });
    activation?.dispose();
  });

  it("reports a failed private scenario without leaking its error content", async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), "installed-smoke-failure-"));
    cleanups.push(() => rm(workingDirectory, { recursive: true, force: true }));
    const vaultPath = join(workingDirectory, "installed-runtime-vault-failure");
    const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "llm-wiki");
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(join(pluginDirectory, "main.js"), "candidate entry point");
    const runners = createAuthoritativeInstalledRuntimeRunners({
      runId: "failure", reportDirectory: join(workingDirectory, "reports"),
    });
    const created = await runners.prepareInstalledRuntimeAcceptanceDriver({
      vaultPath, pluginId: "llm-wiki", candidateBundleSha256: "a".repeat(64),
    });
    let executions = 0;
    const activation = await activateInstalledRuntimeAcceptanceDriver({
      vaultPath, pluginId: "llm-wiki",
      executeSemanticEvidenceScenario: async () => {
        executions += 1;
        throw new Error("PRIVATE NOTE CONTENT /private/path token-secret");
      },
    });
    try {
      await requestInstalledSemanticEvidenceScenario({
        descriptorPath: created.path, descriptor: created.descriptor,
        scenario: "create_note/clean_convergence", expectedVaultId: "vault-123",
        endpoint: new URL("http://127.0.0.1:32123/mcp"),
      });
      const reportPath = join(workingDirectory, "reports", "semantic-evidence-create_note_clean_convergence.json");
      await expect.poll(async () => readFile(reportPath, "utf8").catch(() => "")).not.toBe("");
      const text = await readFile(reportPath, "utf8");
      expect(JSON.parse(text)).toMatchObject({
        runId: "failure", vaultId: "vault-123",
        failure: { code: "scenario_execution_failed" },
      });
      expect(text).not.toMatch(/PRIVATE NOTE|private\/path|token-secret/u);
      expect(executions).toBe(1);
      await expect(runners.semanticEvidenceScenarioRunner.run({
        scenario: "create_note/clean_convergence", expectedVaultId: "vault-123",
        endpoint: new URL("http://127.0.0.1:32123/mcp"), workingDirectory,
      })).rejects.toThrow("scenario failed: scenario_execution_failed");
    } finally { activation?.dispose(); await created.cleanup(); }
  });

  it("publishes a token-bound one-shot scenario command", async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), "installed-smoke-command-"));
    cleanups.push(() => rm(workingDirectory, { recursive: true, force: true }));
    const vaultPath = join(workingDirectory, "installed-runtime-vault-run-123");
    const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "llm-wiki");
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(join(pluginDirectory, "main.js"), "installed candidate\n", "utf8");
    const created = await createInstalledRuntimeAcceptanceDescriptor({
      runId: "run-123",
      vaultPath,
      pluginId: "llm-wiki",
      candidateBundleSha256: "a".repeat(64),
      reportDirectory: join(workingDirectory, "installed-runtime-acceptance-run-123"),
      createCapabilityToken: () => "b".repeat(64),
    });

    await requestInstalledSemanticEvidenceScenario({
      descriptorPath: created.path,
      descriptor: created.descriptor,
      scenario: "create_note/clean_convergence",
      expectedVaultId: "vault-123",
      endpoint: new URL("http://127.0.0.1:32123/mcp"),
    });

    expect(JSON.parse(await readFile(created.path, "utf8"))).toMatchObject({
      command: {
        sequence: 1,
        capabilityToken: "b".repeat(64),
        action: "run-semantic-evidence-scenario",
        scenario: "create_note/clean_convergence",
        expectedVaultId: "vault-123",
        endpoint: "http://127.0.0.1:32123/mcp",
      },
    });
  });

  it("rejects descriptor output outside its generated Vault", async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), "installed-smoke-command-"));
    cleanups.push(() => rm(workingDirectory, { recursive: true, force: true }));
    const vaultPath = join(workingDirectory, "ordinary-vault");
    await mkdir(join(vaultPath, ".obsidian", "plugins", "llm-wiki"), {
      recursive: true,
    });

    await expect(
      createInstalledRuntimeAcceptanceDescriptor({
        runId: "run-123",
        vaultPath,
        pluginId: "llm-wiki",
        candidateBundleSha256: "a".repeat(64),
        reportDirectory: join(workingDirectory, "reports"),
      }),
    ).rejects.toThrow(/generated installed-runtime Vault/u);
  });

  it("arms and removes the private descriptor through the runner lifecycle", async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), "installed-smoke-command-"));
    cleanups.push(() => rm(workingDirectory, { recursive: true, force: true }));
    const vaultPath = join(workingDirectory, "installed-runtime-vault-run-123");
    const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "llm-wiki");
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(join(pluginDirectory, "main.js"), "installed candidate\n", "utf8");
    const runners = createAuthoritativeInstalledRuntimeRunners({
      runId: "run-123",
      reportDirectory: join(workingDirectory, "installed-runtime-acceptance-run-123"),
    });

    const armed = await runners.prepareInstalledRuntimeAcceptanceDriver({
      vaultPath,
      pluginId: "llm-wiki",
      candidateBundleSha256: "a".repeat(64),
    });

    expect(JSON.parse(await readFile(armed.path, "utf8"))).toMatchObject({
      runId: "run-123",
      candidateBundleSha256: "a".repeat(64),
    });
    await armed.cleanup();
    await expect(readFile(armed.path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("round-trips a plugin-produced installed scenario through the authoritative runner", async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), "installed-smoke-command-"));
    cleanups.push(() => rm(workingDirectory, { recursive: true, force: true }));
    const vaultPath = join(workingDirectory, "installed-runtime-vault-run-123");
    const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "llm-wiki");
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(join(pluginDirectory, "main.js"), "installed candidate\n", "utf8");
    const runners = createAuthoritativeInstalledRuntimeRunners({
      runId: "run-123",
      reportDirectory: join(workingDirectory, "installed-runtime-acceptance-run-123"),
    });
    const handle = await runners.prepareInstalledRuntimeAcceptanceDriver({
      vaultPath,
      pluginId: "llm-wiki",
      candidateBundleSha256: "a".repeat(64),
    });
    const summary = {
      scenario: "create_note/clean_convergence",
      source: "installed-obsidian",
      mutationKind: "create_note",
      proofState: "intent_applied",
      statusProofState: "intent_applied",
      journalPhase: "COMMITTED",
      evidenceDeadlineMs: 5_000,
      successBarrierDeadlineMs: 5_000,
      evidenceSessions: [{ mode: "apply", outcome: "converged", virtualElapsedMs: 250 }],
      quietWindowResets: 0,
      acceptedSnapshotRounds: 1,
      rejectedSnapshotRounds: 0,
      successorSnapshot: {
        baselineVersion: 1,
        version: 2,
        immutable: true,
        publishedBeforeIntentApplied: true,
      },
      durableCommitBeforeIntentApplied: true,
      writesBlocked: false,
      beforeInventorySha256: "c".repeat(64),
      afterInventorySha256: "d".repeat(64),
      cleanupSucceeded: true,
    } as const;
    let releaseReport!: () => void;
    const reportReady = new Promise<void>((resolve) => { releaseReport = resolve; });
    const activation = await activateInstalledRuntimeAcceptanceDriver({
      vaultPath,
      pluginId: "llm-wiki",
      executeSemanticEvidenceScenario: async () => {
        await reportReady;
        return summary;
      },
    });
    const endpoint = new URL("http://127.0.0.1:32123/mcp");

    await handle.requestSemanticEvidenceScenario({
      scenario: "create_note/clean_convergence",
      expectedVaultId: "vault-123",
      endpoint,
    });
    const startedAt = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    try {
      const observation = runners.semanticEvidenceScenarioRunner.run({
        scenario: "create_note/clean_convergence",
        endpoint,
        expectedVaultId: "vault-123",
        workingDirectory,
      });
      const completed = observation.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      clock.mockReturnValue(startedAt + 10_001);
      await new Promise((resolve) => setTimeout(resolve, 30));
      releaseReport();
      expect(await completed).toEqual({ value: summary });
    } finally {
      releaseReport();
      clock.mockRestore();
      activation?.dispose();
      await handle.cleanup();
    }
  });

  it("rejects Semantic Evidence reports that are not bound to the installed run", async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), "installed-smoke-command-"));
    cleanups.push(() => rm(workingDirectory, { recursive: true, force: true }));
    const reportPath = join(
      workingDirectory,
      "semantic-evidence-create_note_clean_convergence.json",
    );
    await writeFile(
      reportPath,
      `${JSON.stringify({
        schemaVersion: 1,
        runId: "different-run",
        vaultId: "expected-vault",
        endpoint: "http://127.0.0.1:32123/mcp",
        scenario: "create_note/clean_convergence",
        source: "installed-obsidian",
      })}\n`,
      "utf8",
    );

    const runners = createAuthoritativeInstalledRuntimeRunners({
      runId: "expected-run",
      reportDirectory: workingDirectory,
    });

    await expect(
      runners.semanticEvidenceScenarioRunner.run({
        scenario: "create_note/clean_convergence",
        endpoint: new URL("http://127.0.0.1:32123/mcp"),
        expectedVaultId: "expected-vault",
        workingDirectory,
      }),
    ).rejects.toThrow(/run identity/u);
    expect(await readFile(reportPath, "utf8")).not.toBe("");
  });

  it("does not substitute an in-process corpus when installed control is absent", async () => {
    const runners = createAuthoritativeInstalledRuntimeRunners();

    await expect(
      runners.runGateIsolationCorpus({} as never),
    ).rejects.toThrow(/installed Obsidian acceptance driver/u);
    await expect(
      runners.semanticEvidenceScenarioRunner.run({
        scenario: "create_note/clean_convergence",
        endpoint: new URL("http://127.0.0.1:32123/mcp"),
        expectedVaultId: "expected-vault",
        workingDirectory: ".",
      }),
    ).rejects.toThrow(/installed Obsidian acceptance driver/u);
  });
});
