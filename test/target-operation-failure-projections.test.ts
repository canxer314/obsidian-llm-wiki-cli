import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createTargetOperationCommandRunner } from "../.sandcastle/target-operation-command.js";
import { createTargetOperationRunner } from "../.sandcastle/target-operation.js";

const executeFile = promisify(execFile);
const remoteUrl = "https://github.com/example/target-failure-projection.git";
const diagnosticToken = `ghp_${"s".repeat(36)}`;
const exfiltratedCredential = "fake-secret-for-issue-359";
const encodedDiagnosticToken = Buffer.from(diagnosticToken).toString("base64");
const encodedExfiltratedCredential = Buffer.from(exfiltratedCredential).toString("base64");

const git = async (arguments_: readonly string[], environment?: NodeJS.ProcessEnv): Promise<string> =>
  (await executeFile("git", [...arguments_], { env: environment })).stdout.trim();

type Scenario = {
  readonly name: string;
  readonly operationSource: string;
  readonly setupFailureScript?: string;
  readonly timeoutMilliseconds?: number;
  readonly errorContains?: string;
  readonly expected: {
    readonly result: "resolved" | "rejected";
    readonly checkout: "cleaned" | "retained";
    readonly log: "running" | "completed" | "failed" | "timed-out";
    readonly blocked: boolean;
    readonly diagnostic: boolean;
  };
};

const representativeScenarios: readonly Scenario[] = [
  {
    name: "accepted-refusal",
    operationSource: 'console.log(JSON.stringify({ status: "refused", reason: "already handled" }));\n',
    expected: {
      result: "resolved",
      checkout: "cleaned",
      log: "completed",
      blocked: false,
      diagnostic: false,
    },
  },
  {
    name: "typed-blocked",
    operationSource: 'console.log(JSON.stringify({ status: "blocked", reason: "fixture execution" }));\n',
    expected: {
      result: "resolved",
      checkout: "retained",
      log: "failed",
      blocked: true,
      diagnostic: false,
    },
  },
  {
    name: "invalid-outcome",
    operationSource: 'console.log(JSON.stringify({ status: "reviewed", secret: "must-not-publish" }));\n',
    expected: {
      result: "rejected",
      checkout: "retained",
      log: "failed",
      blocked: true,
      diagnostic: true,
    },
  },
  {
    name: "whole-operation-timeout",
    operationSource: [
      'import { writeFile } from "node:fs/promises";',
      'import { join } from "node:path";',
      'await writeFile(join(import.meta.dirname, "operation-started"), "started\\n");',
      "await new Promise((resolve) => setTimeout(resolve, 30_000));",
      'console.log(JSON.stringify({ status: "implemented" }));',
    ].join("\n"),
    timeoutMilliseconds: 3_000,
    errorContains: "Target operation implement-issue timed out",
    expected: {
      result: "rejected",
      checkout: "retained",
      log: "timed-out",
      blocked: true,
      diagnostic: true,
    },
  },
  {
    name: "malformed-worker-json",
    operationSource: 'console.log("not-json");\n',
    errorContains: "returned invalid JSON",
    expected: {
      result: "rejected",
      checkout: "retained",
      log: "failed",
      blocked: true,
      diagnostic: true,
    },
  },
  {
    name: "missing-worker-json",
    operationSource: 'process.stdout.write("   ");\n',
    errorContains: "did not return a result",
    expected: {
      result: "rejected",
      checkout: "retained",
      log: "failed",
      blocked: true,
      diagnostic: true,
    },
  },
  {
    name: "nonzero-worker-exit",
    operationSource: 'console.error("inner nonzero failure"); process.exit(17);\n',
    errorContains: "worker exited with 17",
    expected: {
      result: "rejected",
      checkout: "retained",
      log: "failed",
      blocked: true,
      diagnostic: true,
    },
  },
  {
    name: "signal-worker-exit",
    operationSource: 'process.kill(process.pid, "SIGTERM");\n',
    errorContains: "worker exited with signal",
    expected: {
      result: "rejected",
      checkout: "retained",
      log: "failed",
      blocked: true,
      diagnostic: true,
    },
  },
  {
    name: "operation-exception",
    operationSource: `throw new Error("operation exception authorization: Bearer ${diagnosticToken}");\n`,
    errorContains: diagnosticToken,
    expected: {
      result: "rejected",
      checkout: "retained",
      log: "failed",
      blocked: true,
      diagnostic: true,
    },
  },
  {
    name: "checkout-setup-failure",
    operationSource: 'console.log(JSON.stringify({ status: "implemented" }));\n',
    setupFailureScript: `node -e "throw new Error('setup failure token=${diagnosticToken}')"`,
    errorContains: diagnosticToken,
    expected: {
      result: "rejected",
      checkout: "retained",
      log: "failed",
      blocked: true,
      diagnostic: true,
    },
  },
  {
    // The preinstall script is untrusted Target revision code: it writes an
    // operation-transformed (base64) credential to stderr, which npm surfaces
    // in its own stderr. Publication must carry only the trusted exit
    // classification; the encoded credential stays in local logs.
    name: "checkout-setup-failure-encoded-credential",
    operationSource: 'console.log(JSON.stringify({ status: "implemented" }));\n',
    setupFailureScript: `node -e "console.error('${encodedExfiltratedCredential}'); process.exit(1)"`,
    errorContains: encodedExfiltratedCredential,
    expected: {
      result: "rejected",
      checkout: "retained",
      log: "failed",
      blocked: true,
      diagnostic: true,
    },
  },
  {
    name: "checkout-cleanup-failure",
    operationSource: [
      'import { chmod, writeFile } from "node:fs/promises";',
      'import { resolve } from "node:path";',
      'await writeFile(resolve(import.meta.dirname, "../../cleanup-attempted"), "accepted before cleanup\\n");',
      'await chmod(resolve(import.meta.dirname, "../../.."), 0o500);',
      'console.log(JSON.stringify({ status: "refused", reason: "accepted before cleanup" }));',
    ].join("\n"),
    errorContains: "EACCES",
    expected: {
      result: "rejected",
      checkout: "retained",
      log: "failed",
      blocked: true,
      diagnostic: true,
    },
  },
  {
    name: "completed-log-finalization-failure",
    operationSource: [
      'import { chmod } from "node:fs/promises";',
      'import { dirname, join } from "node:path";',
      'const stdoutPath = process.env.SANDCASTLE_JOB_STDOUT_LOG;',
      'if (stdoutPath === undefined) throw new Error("job stdout path missing");',
      'await chmod(join(dirname(stdoutPath), "metadata.json"), 0o400);',
      'console.log(JSON.stringify({ status: "refused", reason: "checkout may clean" }));',
    ].join("\n"),
    errorContains: "EACCES",
    expected: {
      result: "rejected",
      checkout: "cleaned",
      log: "running",
      blocked: true,
      diagnostic: true,
    },
  },
  {
    name: "failure-log-finalization-failure",
    operationSource: [
      'import { chmod } from "node:fs/promises";',
      'import { dirname, join } from "node:path";',
      'const stdoutPath = process.env.SANDCASTLE_JOB_STDOUT_LOG;',
      'if (stdoutPath === undefined) throw new Error("job stdout path missing");',
      'await chmod(join(dirname(stdoutPath), "metadata.json"), 0o400);',
      'throw new Error("original execution failure wins");',
    ].join("\n"),
    errorContains: "original execution failure wins",
    expected: {
      result: "rejected",
      checkout: "retained",
      log: "running",
      blocked: true,
      diagnostic: true,
    },
  },
];

describe("Target operation failure projections", () => {
  let root: string;
  let remotePath: string;
  let contributorPath: string;
  let trustedPath: string;
  let checkoutRoot: string;
  let logsPath: string;
  let transport: NodeJS.ProcessEnv;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "target-failure-projections-"));
    remotePath = join(root, "remote.git");
    contributorPath = join(root, "contributor");
    trustedPath = join(root, "trusted");
    checkoutRoot = join(root, "checkouts");
    logsPath = join(root, "logs");
    const binPath = join(root, "bin");

    await git(["init", "--bare", "-b", "master", remotePath]);
    await git(["init", "-b", "master", contributorPath]);
    await git(["-C", contributorPath, "config", "user.name", "Fixture Contributor"]);
    await git(["-C", contributorPath, "config", "user.email", "contributor@example.test"]);
    await mkdir(join(contributorPath, ".sandcastle", "operations"), { recursive: true });
    await writeFile(join(contributorPath, "package.json"), JSON.stringify({
      name: "target-failure-projection-fixture",
      version: "1.0.0",
      private: true,
    }));
    await writeFile(join(contributorPath, "package-lock.json"), JSON.stringify({
      name: "target-failure-projection-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "target-failure-projection-fixture", version: "1.0.0" } },
    }));
    await writeFile(
      join(contributorPath, ".sandcastle", "operations", "implement-issue.ts"),
      'console.log(JSON.stringify({ status: "implemented" }));\n',
    );
    await git(["-C", contributorPath, "add", "-A"]);
    await git(["-C", contributorPath, "commit", "-m", "initial fixture"]);
    await git(["-C", contributorPath, "remote", "add", "origin", remotePath]);
    await git(["-C", contributorPath, "push", "origin", "master"]);
    await git(["clone", "--no-local", remotePath, trustedPath]);
    await git(["-C", trustedPath, "config", "user.name", "Trusted Source"]);
    await git(["-C", trustedPath, "config", "user.email", "trusted@example.test"]);
    await git(["-C", trustedPath, "remote", "set-url", "origin", remoteUrl]);
    await mkdir(binPath);
    const gitWrapper = join(binPath, "git");
    await writeFile(gitWrapper, [
      "#!/usr/bin/env bash",
      'if [[ "$1" == "-C" && "$3" == "fetch" && "$5" == "origin" ]]; then',
      `  exec /usr/bin/git "$1" "$2" "$3" "$4" "${remotePath}" "${"$"}6"`,
      "fi",
      'exec /usr/bin/git "$@"',
    ].join("\n"));
    await chmod(gitWrapper, 0o755);
    transport = {
      HOME: process.env.HOME ?? "",
      PATH: `${binPath}:${process.env.PATH ?? ""}`,
    };
  });

  afterAll(async () => {
    await chmod(checkoutRoot, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const resetProjectionFixture = async (): Promise<void> => {
    await chmod(checkoutRoot, 0o700).catch(() => undefined);
    await rm(checkoutRoot, { recursive: true, force: true });
    await rm(logsPath, { recursive: true, force: true });
  };

  const commitScenario = async (scenario: Scenario): Promise<string> => {
    await writeFile(join(contributorPath, "package.json"), JSON.stringify({
      name: "target-failure-projection-fixture",
      version: "1.0.0",
      private: true,
      ...(scenario.setupFailureScript === undefined
        ? {}
        : { scripts: { preinstall: scenario.setupFailureScript } }),
    }));
    await writeFile(
      join(contributorPath, ".sandcastle", "operations", "implement-issue.ts"),
      scenario.operationSource,
    );
    await git(["-C", contributorPath, "add", "-A"]);
    await git(["-C", contributorPath, "commit", "--allow-empty", "-m", scenario.name]);
    const revision = await git(["-C", contributorPath, "rev-parse", "HEAD"]);
    await git(["-C", contributorPath, "push", "origin", `HEAD:refs/heads/${scenario.name}`]);
    return revision;
  };

  it.each(representativeScenarios)(
    "$name preserves hand-authored checkout, log, and trusted settlement projections",
    async (scenario) => {
      await resetProjectionFixture();
      const revision = await commitScenario(scenario);
      const labels = new Set(["agent:implement"]);
      const diagnostics: Array<{ readonly jobId: string; readonly summary: string }> = [];
      const acquisition = {
        read: vi.fn(async () => ({ state: "OPEN", labels: [...labels], revision })),
        addInProgress: vi.fn(async () => { labels.add("agent:in-progress"); }),
        removeTrigger: vi.fn(async () => { labels.delete("agent:implement"); }),
        addBlocked: vi.fn(async () => { labels.add("agent:blocked"); }),
        addBlockedDiagnostic: vi.fn(async (_operation, _number, diagnostic) => {
          diagnostics.push(diagnostic);
        }),
        removeInProgress: vi.fn(async () => { labels.delete("agent:in-progress"); }),
      };
      const target = createTargetOperationRunner({
        checkoutOptions: {
          sourceRepositoryPath: trustedPath,
          checkoutRoot,
          gitEnvironment: transport,
          dependencyEnvironment: transport,
        },
        jobLogRoot: logsPath,
        startup: {
          imageName: "fixture-image",
          childEnvironments: { git: transport, github: {}, claude: {}, githubAgent: {} },
          models: {
            default: "default-model",
            planner: "planner-model",
            implementer: "implementer-model",
            reviewer: "reviewer-model",
          },
        },
        timeoutMilliseconds: scenario.timeoutMilliseconds ?? 30_000,
        graceMilliseconds: 100,
      });
      const command = createTargetOperationCommandRunner({
        target,
        acquisition,
        createJobId: () => `job-${scenario.name}`,
      });
      const execution = command.run("implement-issue", 219);

      if (scenario.expected.result === "resolved") {
        await expect(execution).resolves.toEqual(expect.objectContaining({
          status: scenario.name === "accepted-refusal" ? "refused" : "blocked",
        }));
      } else {
        const rejected = expect(execution).rejects;
        if (scenario.errorContains === undefined) await rejected.toThrow();
        else await rejected.toThrow(scenario.errorContains);
      }

      const checkoutEntries = await readdir(checkoutRoot).catch(() => []);
      expect(checkoutEntries.length === 0 ? "cleaned" : "retained")
        .toBe(scenario.expected.checkout);
      if (scenario.name === "whole-operation-timeout") {
        expect(checkoutEntries).toHaveLength(1);
        await expect(readFile(
          join(checkoutRoot, checkoutEntries[0]!, ".sandcastle", "operations", "operation-started"),
          "utf8",
        )).resolves.toBe("started\n");
      }
      await expect(readFile(
        join(logsPath, `job-${scenario.name}`, "metadata.json"),
        "utf8",
      ).then(JSON.parse)).resolves.toMatchObject({ status: scenario.expected.log });
      expect(labels.has("agent:blocked")).toBe(scenario.expected.blocked);
      expect(labels.has("agent:in-progress")).toBe(false);
      expect(diagnostics.length > 0).toBe(scenario.expected.diagnostic);
      for (const diagnostic of diagnostics) {
        expect(diagnostic.jobId).toBe(`job-${scenario.name}`);
        expect(diagnostic.summary.length).toBeLessThanOrEqual(500);
        expect(diagnostic.summary).not.toContain("must-not-publish");
        expect(diagnostic.summary).not.toContain(diagnosticToken);
        expect(diagnostic.summary).not.toContain(encodedDiagnosticToken);
        expect(diagnostic.summary).not.toContain(exfiltratedCredential);
        expect(diagnostic.summary).not.toContain(encodedExfiltratedCredential);
      }
    },
    40_000,
  );

  it("rejects an inherited outcome status at the injectable trusted-settlement seam", async () => {
    const labels = new Set(["agent:implement"]);
    const diagnostics: Array<{ readonly jobId: string; readonly summary: string }> = [];
    const revision = "a".repeat(40);
    const acquisition = {
      read: vi.fn(async () => ({ state: "OPEN", labels: [...labels], revision })),
      addInProgress: vi.fn(async () => { labels.add("agent:in-progress"); }),
      removeTrigger: vi.fn(async () => { labels.delete("agent:implement"); }),
      addBlocked: vi.fn(async () => { labels.add("agent:blocked"); }),
      addBlockedDiagnostic: vi.fn(async (_operation, _number, diagnostic) => {
        diagnostics.push(diagnostic);
      }),
      removeInProgress: vi.fn(async () => { labels.delete("agent:in-progress"); }),
    };
    const inheritedOutcome = Object.create({ status: "implemented" }) as object;
    const command = createTargetOperationCommandRunner({
      target: { run: vi.fn(async () => inheritedOutcome) },
      acquisition,
      createJobId: () => "job-inherited-outcome-status",
    });

    await expect(command.run("implement-issue", 359)).rejects
      .toThrow("Target operation returned an invalid outcome");

    expect(labels).toEqual(new Set(["agent:blocked"]));
    expect(acquisition.addBlocked).toHaveBeenCalledTimes(1);
    expect(acquisition.removeInProgress).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual([{
      jobId: "job-inherited-outcome-status",
      summary: "Target operation returned an invalid outcome",
    }]);
  });

  it("projects malformed worker JSON without publishing its arbitrary payload", async () => {
    await resetProjectionFixture();
    const malformedPayloadMarker = "ARBITRARY-MALFORMED-WORKER-PAYLOAD-359";
    const scenario: Scenario = {
      name: "malformed-worker-json-secrecy",
      operationSource: `console.log('{"status":"implemented","marker": ${malformedPayloadMarker}}');\n`,
      expected: {
        result: "rejected",
        checkout: "retained",
        log: "failed",
        blocked: true,
        diagnostic: true,
      },
    };
    const revision = await commitScenario(scenario);
    const labels = new Set(["agent:implement"]);
    const diagnostics: Array<{ readonly jobId: string; readonly summary: string }> = [];
    const acquisition = {
      read: vi.fn(async () => ({ state: "OPEN", labels: [...labels], revision })),
      addInProgress: vi.fn(async () => { labels.add("agent:in-progress"); }),
      removeTrigger: vi.fn(async () => { labels.delete("agent:implement"); }),
      addBlocked: vi.fn(async () => { labels.add("agent:blocked"); }),
      addBlockedDiagnostic: vi.fn(async (_operation, _number, diagnostic) => {
        diagnostics.push(diagnostic);
      }),
      removeInProgress: vi.fn(async () => { labels.delete("agent:in-progress"); }),
    };
    const target = createTargetOperationRunner({
      checkoutOptions: {
        sourceRepositoryPath: trustedPath,
        checkoutRoot,
        gitEnvironment: transport,
        dependencyEnvironment: transport,
      },
      jobLogRoot: logsPath,
      startup: {
        imageName: "fixture-image",
        childEnvironments: { git: transport, github: {}, claude: {}, githubAgent: {} },
        models: {
          default: "default-model",
          planner: "planner-model",
          implementer: "implementer-model",
          reviewer: "reviewer-model",
        },
      },
      timeoutMilliseconds: 30_000,
      graceMilliseconds: 100,
    });
    const command = createTargetOperationCommandRunner({
      target,
      acquisition,
      createJobId: () => "job-malformed-worker-json-secrecy",
    });

    const execution = command.run("implement-issue", 359);
    await expect(execution).rejects.toThrow("returned invalid JSON");
    await expect(execution).rejects.not.toThrow(malformedPayloadMarker);

    await expect(readFile(
      join(logsPath, "job-malformed-worker-json-secrecy", "metadata.json"),
      "utf8",
    ).then(JSON.parse)).resolves.toMatchObject({ status: "failed" });
    expect(labels).toEqual(new Set(["agent:blocked"]));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      jobId: "job-malformed-worker-json-secrecy",
    });
    // Worker-exit stderr is an untrusted channel, so publication carries only
    // the classified exit summary; the specific "returned invalid JSON"
    // reason stays in the local job log for the operator.
    expect(diagnostics[0]!.summary)
      .toBe("Target operation implement-issue worker exited with 1");
    expect(diagnostics[0]!.summary).not.toContain(malformedPayloadMarker);
  });

  it("keeps an operation-exfiltrated encoded credential in local logs but out of the published diagnostic", async () => {
    await resetProjectionFixture();
    const scenario: Scenario = {
      name: "encoded-credential-stderr-exfiltration",
      // The operation is untrusted Target revision code. It reads the startup
      // credential delivered on stdin, base64-encodes it, writes it to stderr,
      // and exits unsuccessfully — the exact trust-boundary chain rejected by
      // the #359 acceptance re-review.
      operationSource: [
        'let input = "";',
        "for await (const chunk of process.stdin) input += chunk;",
        "const startup = JSON.parse(input);",
        "const credential = startup.childEnvironments.github.GH_TOKEN;",
        'if (typeof credential !== "string") throw new Error("startup credential missing");',
        'console.error(Buffer.from(credential, "utf8").toString("base64"));',
        "process.exit(1);",
      ].join("\n"),
      expected: {
        result: "rejected",
        checkout: "retained",
        log: "failed",
        blocked: true,
        diagnostic: true,
      },
    };
    const revision = await commitScenario(scenario);
    const labels = new Set(["agent:implement"]);
    const diagnostics: Array<{ readonly jobId: string; readonly summary: string }> = [];
    const acquisition = {
      read: vi.fn(async () => ({ state: "OPEN", labels: [...labels], revision })),
      addInProgress: vi.fn(async () => { labels.add("agent:in-progress"); }),
      removeTrigger: vi.fn(async () => { labels.delete("agent:implement"); }),
      addBlocked: vi.fn(async () => { labels.add("agent:blocked"); }),
      addBlockedDiagnostic: vi.fn(async (_operation, _number, diagnostic) => {
        diagnostics.push(diagnostic);
      }),
      removeInProgress: vi.fn(async () => { labels.delete("agent:in-progress"); }),
    };
    const target = createTargetOperationRunner({
      checkoutOptions: {
        sourceRepositoryPath: trustedPath,
        checkoutRoot,
        gitEnvironment: transport,
        dependencyEnvironment: transport,
      },
      jobLogRoot: logsPath,
      startup: {
        imageName: "fixture-image",
        childEnvironments: {
          git: transport,
          github: { GH_TOKEN: exfiltratedCredential },
          claude: {},
          githubAgent: {},
        },
        models: {
          default: "default-model",
          planner: "planner-model",
          implementer: "implementer-model",
          reviewer: "reviewer-model",
        },
      },
      timeoutMilliseconds: 30_000,
      graceMilliseconds: 100,
    });
    const command = createTargetOperationCommandRunner({
      target,
      acquisition,
      createJobId: () => "job-encoded-credential-exfiltration",
    });

    const execution = command.run("implement-issue", 359);
    // The full untrusted stderr remains available in the local failure.
    await expect(execution).rejects.toThrow(encodedExfiltratedCredential);
    await expect(readFile(
      join(logsPath, "job-encoded-credential-exfiltration", "stderr.log"),
      "utf8",
    )).resolves.toContain(encodedExfiltratedCredential);

    // Trusted settlement keeps the checkout retained, the log failed, and
    // publishes only the classified exit summary — never the raw credential,
    // its base64 transformation, or any other untrusted stderr text.
    await expect(readdir(checkoutRoot)).resolves.toHaveLength(1);
    await expect(readFile(
      join(logsPath, "job-encoded-credential-exfiltration", "metadata.json"),
      "utf8",
    ).then(JSON.parse)).resolves.toMatchObject({ status: "failed" });
    expect(labels).toEqual(new Set(["agent:blocked"]));
    expect(diagnostics).toEqual([{
      jobId: "job-encoded-credential-exfiltration",
      summary: "Target operation implement-issue worker exited with 1",
    }]);
    expect(diagnostics[0]!.summary).not.toContain(exfiltratedCredential);
    expect(diagnostics[0]!.summary).not.toContain(encodedExfiltratedCredential);
  }, 40_000);

  it("projects scheduled architecture review failure without Automation Work Item settlement", async () => {
    await resetProjectionFixture();
    await writeFile(join(contributorPath, "package.json"), JSON.stringify({
      name: "target-failure-projection-fixture",
      version: "1.0.0",
      private: true,
    }));
    await writeFile(
      join(contributorPath, ".sandcastle", "operations", "architecture-review.ts"),
      'console.log(JSON.stringify({ status: "implemented" }));\n',
    );
    await git(["-C", contributorPath, "add", "-A"]);
    await git(["-C", contributorPath, "commit", "-m", "scheduled architecture failure"]);
    const revision = await git(["-C", contributorPath, "rev-parse", "HEAD"]);
    await git(["-C", contributorPath, "push", "origin", "HEAD:refs/heads/scheduled-architecture-failure"]);
    const target = createTargetOperationRunner({
      checkoutOptions: {
        sourceRepositoryPath: trustedPath,
        checkoutRoot,
        gitEnvironment: transport,
        dependencyEnvironment: transport,
      },
      jobLogRoot: logsPath,
      startup: {
        imageName: "fixture-image",
        childEnvironments: { git: transport, github: {}, claude: {}, githubAgent: {} },
        models: {
          default: "default-model",
          planner: "planner-model",
          implementer: "implementer-model",
          reviewer: "reviewer-model",
        },
      },
      timeoutMilliseconds: 30_000,
      graceMilliseconds: 100,
    });

    await expect(target.run({
      operation: "architecture-review",
      revision,
      jobId: "scheduled-architecture-failure",
    })).rejects.toThrow("Target operation returned an invalid outcome");
    await expect(readdir(checkoutRoot)).resolves.toHaveLength(1);
    await expect(readFile(
      join(logsPath, "scheduled-architecture-failure", "metadata.json"),
      "utf8",
    ).then(JSON.parse)).resolves.toMatchObject({
      operation: "architecture-review",
      status: "failed",
    });
  }, 40_000);
});
