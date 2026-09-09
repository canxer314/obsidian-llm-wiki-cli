import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { CheckoutObserver } from "../.sandcastle/checkout-safety.js";
import { createSameSessionArchitectureReviewExtractor } from "../.sandcastle/architecture-review-extraction.js";
import { createProcessBranchUpdater } from "../.sandcastle/branch-update-process-runner.js";
import { createBranchUpdateConflictResolverSession } from "../.sandcastle/branch-update-conflict-resolver.js";
import { createFeedbackProduceRecovery } from "../.sandcastle/feedback-recovery.js";
import { createFeedbackImplementerSession } from "../.sandcastle/feedback-implementer-session.js";
import { implementIssue, implementSpecChild } from "../.sandcastle/implementer.js";
import { createSandcastleImplementerSession } from "../.sandcastle/implementer-session.js";
import {
  invokeWithRecovery,
  MAX_INVOCATION_ATTEMPTS,
  StopRetryError,
} from "../.sandcastle/invocation-recovery.js";
import { createJobLog, type JobLog } from "../.sandcastle/job-logs.js";
import { createSandcastlePlannerSession } from "../.sandcastle/planner-session.js";
import { createSameSessionReviewExtractor } from "../.sandcastle/review-extraction.js";
import { createReviewProduceRecovery } from "../.sandcastle/review-recovery.js";
import { createSameSessionSpecSplitExtractor } from "../.sandcastle/spec-split-extraction.js";
import {
  MAX_STRUCTURED_ATTEMPTS,
  createStructuredExtractionDriver,
} from "../.sandcastle/structured-extraction-driver.js";
import { targetOperationTimeout } from "../.sandcastle/target-operation.js";

// The covered-path entry functions, statically imported so the inventory can
// prove each role's seam is actually surfaced to its worker.
const FACTORY_BY_EXPORT: Readonly<Record<string, unknown>> = {
  createBranchUpdateConflictResolverSession,
  createFeedbackImplementerSession,
  createFeedbackProduceRecovery,
  createProcessBranchUpdater,
  createReviewProduceRecovery,
  createSameSessionArchitectureReviewExtractor,
  createSameSessionReviewExtractor,
  createSameSessionSpecSplitExtractor,
  createSandcastleImplementerSession,
  createSandcastlePlannerSession,
  implementIssue,
  implementSpecChild,
};

// High-level recovery coverage conformance (Spec #449 child #460). This is
// the final verification slice: it inventories every production Sandcastle
// Agent invocation site and proves, at the repository-owned seam level, that
// each covered path runs through the shared bounded invocation-recovery
// window and/or structured-extraction driver, never arms Sandcastle's
// recursive output retry, never nests a second invocation budget around a
// structured handoff, keeps the whole-job Target limits unchanged, and
// records only sanitized metadata in the append-only Job Logs. The deeper
// per-role operation-level proofs (recovered success equals first-attempt
// success, exhaustion retains Blocked Automation, durable work from failed
// invocations never counts, publication runs zero times on exhaustion and at
// most once after eventual success) live in the role-targeted suites
// exercised alongside this file.

const sandcastleDir = resolve(import.meta.dirname, "../.sandcastle");

const revision = "0123456789abcdef0123456789abcdef01234567";

function sandcastleSource(name: string): string {
  return readFileSync(resolve(sandcastleDir, name), "utf8");
}

function automationSourceNames(): string[] {
  return readdirSync(sandcastleDir)
    .filter((name) => name.endsWith(".ts"))
    .sort();
}

// The absence guards below describe code behavior. Comment-only lines are
// stripped before matching so explanatory prose never counts as a live
// execution path.
function executableContent(content: string): string {
  return content.split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*"));
    })
    .join("\n");
}

function sourceOccurrences(name: string, token: string): number {
  return executableContent(sandcastleSource(name)).split(token).length - 1;
}

// ---------------------------------------------------------------------------
// Invocation-site inventory
// ---------------------------------------------------------------------------

interface InvocationWindow {
  readonly role: string;
  readonly stage: string;
}

interface InvocationSite {
  // The role vocabulary used by the Spec #449 issue and its child tickets.
  readonly agentRole: string;
  // The .sandcastle modules that own this site's Agent session (not the
  // top-level operation entries, which only pass the checkout through).
  readonly modules: readonly string[];
  // Repository-owned seams the site must route through.
  readonly seams: readonly string[];
  // The recovery-window role/stage labels that reach the append-only Job Log.
  readonly windows: readonly InvocationWindow[];
  // Exported factory / entry functions that the covered path surfaces.
  readonly exported: Readonly<Record<string, string>>;
}

// Every production Sandcastle Agent invocation site. A new role must extend
// this table and the raw-run allow-list below or the completeness checks fail.
const INVOCATION_SITES: readonly InvocationSite[] = [
  {
    agentRole: "Planner",
    modules: ["planner-session.ts"],
    seams: ["createStructuredExtractionDriver"],
    windows: [{ role: "planner", stage: "structured-extraction" }],
    exported: { "planner-session.ts": "createSandcastlePlannerSession" },
  },
  {
    agentRole: "Spec splitter",
    modules: ["spec-split-extraction.ts", "spec-split-worker.ts"],
    seams: ["createStructuredExtractionDriver"],
    windows: [{ role: "spec-splitter", stage: "structured-extraction" }],
    exported: { "spec-split-extraction.ts": "createSameSessionSpecSplitExtractor" },
  },
  {
    agentRole: "Architecture reviewer",
    modules: ["architecture-review-extraction.ts", "architecture-review-worker.ts"],
    seams: ["createStructuredExtractionDriver"],
    windows: [{ role: "architecture-reviewer", stage: "structured-extraction" }],
    exported: {
      "architecture-review-extraction.ts": "createSameSessionArchitectureReviewExtractor",
    },
  },
  {
    agentRole: "Reviewer",
    modules: ["review-recovery.ts", "review-extraction.ts", "review-worker.ts"],
    seams: ["invokeWithRecovery", "createStructuredExtractionDriver", "runAgent"],
    windows: [
      { role: "reviewer", stage: "produce" },
      { role: "reviewer", stage: "review-formatting" },
    ],
    exported: {
      "review-recovery.ts": "createReviewProduceRecovery",
      "review-extraction.ts": "createSameSessionReviewExtractor",
    },
  },
  {
    agentRole: "Feedback Implementer",
    modules: ["feedback-recovery.ts", "feedback-implementer-session.ts", "feedback-worker.ts"],
    seams: ["invokeWithRecovery", "createStructuredExtractionDriver", "runAgent"],
    windows: [
      { role: "feedback-implementer", stage: "produce" },
      { role: "feedback-implementer", stage: "feedback-formatting" },
    ],
    exported: {
      "feedback-recovery.ts": "createFeedbackProduceRecovery",
      "feedback-implementer-session.ts": "createFeedbackImplementerSession",
    },
  },
  {
    agentRole: "Issue Implementer",
    modules: ["implementer.ts", "implementer-session.ts", "implementation-worker.ts"],
    seams: ["invokeWithRecovery", "runAgent"],
    windows: [{ role: "implementer", stage: "implementation" }],
    exported: {
      "implementer.ts": "implementIssue",
      "implementer-session.ts": "createSandcastleImplementerSession",
    },
  },
  {
    agentRole: "Spec Implementer",
    modules: ["implementer.ts", "implementer-session.ts", "spec-implementation-worker.ts"],
    seams: ["invokeWithRecovery", "runAgent"],
    windows: [{ role: "implementer", stage: "implementation" }],
    exported: {
      "implementer.ts": "implementSpecChild",
      "implementer-session.ts": "createSandcastleImplementerSession",
    },
  },
  {
    agentRole: "branch-conflict resolver",
    modules: ["branch-update-process-runner.ts", "branch-update-conflict-resolver.ts"],
    seams: ["invokeWithRecovery", "createStructuredExtractionDriver", "runAgent"],
    windows: [
      { role: "merger", stage: "conflict-resolution" },
      { role: "merger", stage: "resolution-formatting" },
    ],
    exported: {
      "branch-update-process-runner.ts": "createProcessBranchUpdater",
      "branch-update-conflict-resolver.ts": "createBranchUpdateConflictResolverSession",
    },
  },
];

// The complete raw SDK invocation set. Every file that hands a run/resume
// call to Sandcastle must be the shared driver, a produce module owned by an
// inventory row, or the documented legacy same-session module that no
// production path wires in.
const EXPECTED_RAW_RUN_MODULES = [
  "branch-update-conflict-resolver.ts",
  "feedback-recovery.ts",
  "implementer-session.ts",
  "review-recovery.ts",
  "same-session-structured-extraction.ts",
  "structured-extraction-driver.ts",
].sort();

// The only modules that may open a bounded invocation-recovery window. Every
// window is one logical Agent stage; no module nests a second window.
const EXPECTED_WINDOW_OWNERS = [
  "branch-update-process-runner.ts",
  "feedback-recovery.ts",
  "implementer.ts",
  "review-recovery.ts",
  "structured-extraction-driver.ts",
].sort();

describe("Spec #449 recovery coverage conformance", () => {
  describe("every production Sandcastle Agent invocation site is covered", () => {
    it.each(INVOCATION_SITES)(
      "accounts for the $agentRole invocation site through the shared recovery seam",
      (site) => {
        const combined = site.modules.map((module) => sandcastleSource(module)).join("\n");
        // The row's modules collectively route through the repository-owned
        // seam: a direct produce window (invokeWithRecovery), a structured
        // pass (createStructuredExtractionDriver), or a raw produce run the
        // owning window drives (runAgent).
        for (const seam of site.seams) {
          expect(executableContent(combined), `${site.agentRole} must route through ${seam}`)
            .toContain(seam);
        }
        for (const window of site.windows) {
          expect(executableContent(combined), `${site.agentRole} ${window.role} window label`)
            .toContain(`role: "${window.role}"`);
          expect(executableContent(combined), `${site.agentRole} ${window.stage} window stage`)
            .toContain(`stage: "${window.stage}"`);
        }
        // Every worker module that owns no seam of its own must still wire the
        // row's covered entry function, so it cannot reach an Agent session
        // outside the shared window.
        for (const module of site.modules) {
          const source = executableContent(sandcastleSource(module));
          if (sourceOccurrences(module, "invokeWithRecovery(") > 0
            || sourceOccurrences(module, "runAgent(") > 0
            || source.includes("createStructuredExtractionDriver")) {
            continue;
          }
          const wired = Object.values(site.exported)
            .some((exportName) => source.includes(`${exportName}(`) || source.includes(`{ ${exportName}`));
          expect(wired, `${module} must wire a covered ${site.agentRole} entry`).toBe(true);
        }
        // The role's seam must actually be surfaced to its worker.
        for (const exportName of Object.values(site.exported)) {
          expect(typeof FACTORY_BY_EXPORT[exportName], `${exportName} must be exported`)
            .toBe("function");
        }
      },
    );

    it("the raw-SDK invocation set is exactly the driver, the produce modules, and the documented legacy module", () => {
      const rawRunModules = automationSourceNames().filter((name) =>
        /runAgent\(|\.resume\(/u.test(sandcastleSource(name)));
      expect(rawRunModules).toEqual(EXPECTED_RAW_RUN_MODULES);

      const referenced = new Set(INVOCATION_SITES.flatMap((site) => site.modules));
      for (const name of EXPECTED_RAW_RUN_MODULES) {
        // The shared driver is the single enforcement point for every
        // structured role; the legacy same-session module is kept only as the
        // documented origin of the classification helpers and is wired to no
        // production worker. Every other raw-run module belongs to a row.
        if (name === "structured-extraction-driver.ts" || name === "same-session-structured-extraction.ts") {
          continue;
        }
        expect(referenced.has(name), `${name} must be owned by an inventory row`).toBe(true);
      }

      // The legacy same-session *extractor* factories are not wired anywhere:
      // no production module imports them, so they cannot become an
      // undocumented invocation site.
      const legacyFactories = ["createSameSessionStructuredExtractor", "withStructuredOutputErrorClassification"];
      for (const name of automationSourceNames()) {
        if (name === "same-session-structured-extraction.ts") continue;
        const source = executableContent(sandcastleSource(name));
        for (const factory of legacyFactories) {
          expect(source, `${name} must not import the legacy ${factory}`).not.toContain(factory);
        }
      }
    });
  });

  describe("no covered path arms recursive output retry or nests a second invocation budget", () => {
    it("keeps both recovery budgets at their normative bounds", () => {
      expect(MAX_INVOCATION_ATTEMPTS).toBe(3);
      expect(MAX_STRUCTURED_ATTEMPTS).toBe(3);
    });

    it("runs every structured attempt inside exactly one invocation window owned by the driver", () => {
      const driver = sandcastleSource("structured-extraction-driver.ts");
      // One invocation window per structured attempt, never nested inside the
      // parse handoff: the driver opens exactly one window per attempt and the
      // structured budget is the enclosing loop.
      expect(sourceOccurrences("structured-extraction-driver.ts", "invokeWithRecovery(")).toBe(1);
      expect(driver).toContain("class StructuredAttemptHandoff extends StopRetryError");
      // A completed invalid response leaves the invocation window through the
      // controlled stop-retry sentinel, so the parse handoff can never create
      // or reset another invocation budget.
      expect(driver).toContain("structuredOrdinal <= MAX_STRUCTURED_ATTEMPTS");
      expect(driver).toContain("instanceof StructuredAttemptHandoff");
      expect(driver).toContain("throw new StructuredAttemptHandoff(classified, checkpointOf(result));");
    });

    it("opens an invocation window in exactly the five window-owner modules", () => {
      const owners = automationSourceNames().filter((name) =>
        sourceOccurrences(name, "invokeWithRecovery(") > 0);
      expect(owners).toEqual(EXPECTED_WINDOW_OWNERS);
    });

    it("never hands an output definition to a Sandcastle run or resume call", () => {
      // The only `output:` code occurrences allowed in a raw-run module are a
      // structured-extraction plan (`output: { tag: ... }`) handed to the
      // repository-owned driver or a type member; an SDK run/resume option
      // named `output` would be a new occurrence of a different shape.
      const rawRunModules = EXPECTED_RAW_RUN_MODULES.filter((name) =>
        name !== "same-session-structured-extraction.ts");
      for (const name of rawRunModules) {
        const code = executableContent(sandcastleSource(name));
        const outputLines = code.split("\n").filter((line) => line.includes("output:"));
        for (const line of outputLines) {
          const trimmed = line.trim();
          const allowed = trimmed.startsWith("output: { tag:")
            || trimmed.startsWith("readonly output:");
          expect(allowed, `${name} must not pass an SDK output option: ${trimmed}`).toBe(true);
        }
      }
      // No run/resume call in the whole production tree arms the library's
      // recursive output retry by referencing maxRetries in code.
      for (const name of automationSourceNames()) {
        const code = executableContent(sandcastleSource(name));
        expect(code, `${name} must not configure maxRetries`).not.toContain("maxRetries");
      }
    });

    it("keeps driver-covered role modules free of direct windows and raw runs", () => {
      // Planner, Spec splitter, Architecture reviewer, and the Reviewer /
      // Feedback formatting stages obtain their bounded windows solely from
      // the shared driver; a direct invokeWithRecovery here would nest a
      // second budget around a structured pass.
      const driverCovered = [
        "architecture-review-extraction.ts",
        "feedback-implementer-session.ts",
        "planner-session.ts",
        "review-extraction.ts",
        "spec-split-extraction.ts",
      ];
      for (const name of driverCovered) {
        expect(sourceOccurrences(name, "invokeWithRecovery("), `${name} must stay driver-owned`)
          .toBe(0);
        expect(sourceOccurrences(name, "runAgent("), `${name} must not raw-run`).toBe(0);
      }
    });
  });

  describe("Target-operation job limits stay whole-job and unchanged", () => {
    it("keeps the 90-minute, 135-minute, and 31.5-minute whole-job limits", () => {
      expect(targetOperationTimeout("implement-issue")).toBe(90 * 60 * 1000);
      expect(targetOperationTimeout("implement-spec")).toBe(90 * 60 * 1000);
      expect(targetOperationTimeout("implement-feedback")).toBe(90 * 60 * 1000);
      expect(targetOperationTimeout("review")).toBe(135 * 60 * 1000);
      expect(targetOperationTimeout("update-branch")).toBe(90 * 60 * 1000);
      expect(targetOperationTimeout("split-spec")).toBe(90 * 60 * 1000);
      expect(targetOperationTimeout("architecture-review")).toBe(31.5 * 60 * 1000);
    });

    it("keeps recovery budgets out of the whole-job timeout definition", () => {
      const timeoutSource = executableContent(sandcastleSource("target-operation.ts"));
      for (const token of ["MAX_INVOCATION_ATTEMPTS", "MAX_STRUCTURED_ATTEMPTS", "invokeWithRecovery"]) {
        expect(timeoutSource, `target-operation.ts must not reference ${token}`).not.toContain(token);
      }
      // No implementation promises equal time per attempt by dividing a Target
      // limit by a recovery budget, and no test does so either (checked on the
      // production sources and on a per-test read that skips this file's own
      // guard text).
      for (const name of automationSourceNames()) {
        const source = executableContent(sandcastleSource(name));
        expect(source, `${name} must not share a Target limit across attempts`)
          .not.toMatch(/\/\s*MAX_(INVOCATION|STRUCTURED)_ATTEMPTS/u);
      }
      const testDir = resolve(import.meta.dirname);
      const equalTimePromise = /targetOperationTimeout\([^)]*\)\s*\/|timeoutMilliseconds\s*\/\s*(3|MAX_)/u;
      for (const name of readdirSync(testDir).filter((name) => name.endsWith(".test.ts"))) {
        if (name === "recovery-coverage-conformance.test.ts") continue;
        const source = readFileSync(resolve(testDir, name), "utf8");
        expect(source, `${name} must not promise equal time per attempt`)
          .not.toMatch(equalTimePromise);
      }
    });

    it("keeps the recovery kernel and shared driver free of automation-command settlement", () => {
      // The recovery window must never become an implicit Automation Command
      // retry: the kernel never removes agent:blocked, never restores a
      // trigger, never redispatches, and never performs a GitHub mutation.
      const kernelFiles = [
        "checkout-safety.ts",
        "invocation-recovery.ts",
        "job-logs.ts",
        "structured-extraction-driver.ts",
      ];
      const forbidden = [
        "agent:blocked",
        "agent:in-progress",
        "removeTrigger",
        "addBlocked",
        "addBlockedDiagnostic",
        "redispatch",
        "gh api",
        "gh pr",
        "gh issue",
      ];
      for (const name of kernelFiles) {
        const code = executableContent(sandcastleSource(name));
        for (const token of forbidden) {
          expect(code, `${name} must not ${token}`).not.toContain(token);
        }
      }
    });
  });

  describe("append-only Job Logs carry only sanitized metadata", () => {
    const outputSchema = z.strictObject({ value: z.string() });
    const sandbox = { kind: "fake-sandbox" } as never;
    const hooks = { sandbox: { onSandboxReady: [] } };

    const forbiddenHtml = [
      "<html><head><title>403 Forbidden</title></head><body>",
      "<h1>Unable to load site</h1>",
      "<p>Please try again later.</p>",
      `<!-- authorization: Bearer sk-ant-${"a".repeat(30)} token=ghp_${"b".repeat(36)} -->`,
      "<p>gateway: https://proxy.internal.example/v1/messages?key=secret-key</p>",
      "</body></html>",
    ].join("\n");
    const forbiddenSecrets = [
      "Unable to load site",
      "Please try again later",
      "sk-ant-",
      "ghp_",
      "proxy.internal.example",
      "secret-key",
    ];

    // The exact metadata vocabulary the three append-only writers may emit.
    // Anything else is a regression: raw provider output, HTML, headers, URLs,
    // transcripts, or credentials must never appear as log values or keys.
    const ALLOWED_LOG_KEYS = new Set([
      "role",
      "stage",
      "attempt",
      "nextAttempt",
      "delayClass",
      "delayMilliseconds",
      "outcome",
      "reason",
      "attempts",
      "structuredAttempt",
      "structuredAttempts",
      "failureKind",
      "checkpoint",
      "label",
    ]);

    async function newJobLog(): Promise<JobLog> {
      const root = mkdtempSync(join(tmpdir(), "recovery-conformance-log-"));
      return createJobLog({
        root,
        jobId: "job-460",
        operation: "implement-issue",
        revision,
        now: 1_000,
      });
    }

    function parseLogEntries(stderr: string): { readonly prefix: string; readonly payload: Record<string, unknown> }[] {
      const entries: { readonly prefix: string; readonly payload: Record<string, unknown> }[] = [];
      for (const line of stderr.split("\n")) {
        const match = /^\[(invocation-recovery|structured-extraction|implementer-branch-state)\] (.*)$/u.exec(line);
        if (match !== null) {
          entries.push({ prefix: match[1]!, payload: JSON.parse(match[2]!) as Record<string, unknown> });
        }
      }
      return entries;
    }

    function assertOnlyAllowedKeys(stderr: string): void {
      expect(stderr).not.toContain("<html");
      for (const secret of forbiddenSecrets) {
        expect(stderr).not.toContain(secret);
      }
      const entries = parseLogEntries(stderr);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        for (const key of Object.keys(entry.payload)) {
          expect(ALLOWED_LOG_KEYS.has(key), `unexpected Job Log key ${key} in [${entry.prefix}]`)
            .toBe(true);
        }
      }
    }

    it("writes invocation-recovery retry and stop metadata with only the allowed keys", async () => {
      const log = await newJobLog();
      const wait = vi.fn(async () => {});
      const gateway = new Error(forbiddenHtml);

      const retried = await invokeWithRecovery(async (context) => {
        if (context.ordinal === 1) throw gateway;
        return "recovered";
      }, { role: "planner", stage: "structured-extraction", log, wait });
      expect(retried).toBe("recovered");

      await expect(invokeWithRecovery(async () => {
        throw new StopRetryError("repository-owned invariant stopped the window");
      }, { role: "reviewer", stage: "produce", log, wait })).rejects.toThrow(StopRetryError);

      const stderr = readFileSync(log.stderrPath, "utf8");
      expect(stderr).toContain("[invocation-recovery]");
      expect(stderr).toContain("\"outcome\":\"stopped\"");
      assertOnlyAllowedKeys(stderr);
    });

    it("writes structured-extraction exhaustion metadata with only the allowed keys", async () => {
      const log = await newJobLog();
      const wait = vi.fn(async () => {});
      const invalidResult = () => completedResult("no usable block here", {
        resume: resume as unknown,
        sessionId: "session-1",
      });
      const resume = vi.fn(async () => invalidResult());
      const runAgent = vi.fn(async () => invalidResult());
      const observer = fakeObserver();
      const driver = createStructuredExtractionDriver({
        sandbox,
        hooks,
        checkoutPath: "/safe/checkout",
        role: "planner",
        stage: "structured-extraction",
        observer: observer.observer,
        wait,
        runAgent: runAgent as never,
        createAgent: vi.fn().mockReturnValue({ name: "fake-agent" }) as never,
        log,
      });

      await expect(driver.extract({
        model: "driver-model",
        name: "driver-test",
        initialPrompt: "complete the read-only task",
        readOnlyContract: "Read-only contract: change nothing in this checkout.",
        output: { tag: "result", schema: outputSchema },
      })).rejects.toThrow(/could not be parsed|Structured output tag/u);

      const stderr = readFileSync(log.stderrPath, "utf8");
      expect(stderr).toContain("[structured-extraction]");
      expect(stderr).toContain("\"structuredAttempt\"");
      expect(stderr).toContain("\"structuredAttempts\":3");
      expect(stderr).toContain("\"outcome\":\"exhausted\"");
      assertOnlyAllowedKeys(stderr);
    });

    function completedResult(stdout: string, extras: { readonly resume?: unknown; readonly sessionId?: string }) {
      return {
        stdout,
        commits: [{ sha: "c".repeat(40) }],
        branch: "head-branch",
        ...(extras.sessionId === undefined ? {} : { iterations: [{ sessionId: extras.sessionId }] }),
        ...(extras.resume === undefined ? {} : { resume: extras.resume }),
      };
    }

    function fakeObserver() {
      const snapshot = { head: "a".repeat(40), entries: [] };
      const observer = {
        observe: vi.fn().mockResolvedValue(snapshot),
        requireClean: vi.fn().mockResolvedValue(snapshot),
        requireUnchanged: vi.fn().mockResolvedValue(snapshot),
      } as CheckoutObserver;
      return { observer };
    }
  });
});
