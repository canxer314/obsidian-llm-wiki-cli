import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  commandEligibility,
  type AutomationCommand,
} from "./automation-command.ts";
import {
  canonicalAutomationTriggerLabels,
  resolveAutomationCommandRoute,
  resolveTargetOperationRoute,
} from "./automation-command-route.ts";

// ADR-0004: an interrupted job is provably dead only once its recorded start
// is at least five minutes old, bounding the risk of adopting a live job.
export const INTERRUPTED_AUTOMATION_GRACE_MILLISECONDS = 5 * 60 * 1000;

// #423 establishes recovery for the Issue and Spec implementation families,
// #424 extends it to Spec splitting, and #425 completes it for the Pull
// Request command families (branch update, feedback implementation, and
// review). The set holds the recorded Target operations recovery can prove
// dead; update-branch, review, and implement-feedback are what the Pull
// Request families record in their job logs (implement-feedback is the
// feedback implementation family's recorded operation for a typed
// "implement" command). Families that share an identity namespace while
// routing to different triggers (implement-spec/split-spec on spec:<number>,
// the update-branch/implement/review families on pull-request:<number>) rely
// on the operation-equality guard in attempt().
const recoverableOperations: ReadonlySet<string> = new Set([
  "implement-issue",
  "implement-spec",
  "split-spec",
  "update-branch",
  "review",
  "implement-feedback",
]);

export interface InterruptedAutomationJobRecord {
  readonly jobId: string;
  readonly operation: string;
  readonly number?: number;
  readonly status: string;
  readonly startedAt: number;
}

export interface InterruptedAutomationEvidence {
  readonly records: readonly InterruptedAutomationJobRecord[];
  // Directories whose metadata is missing, unreadable, or invalid. Such a
  // record might be a live match for any identity, so its presence refuses
  // every recovery in the round (fail closed, ADR-0004).
  readonly unreadable: readonly string[];
}

export interface InterruptedAutomationRecoveryDiagnostic {
  readonly jobId: string;
  readonly operation: string;
  readonly trigger: string;
  readonly triggerRestored: boolean;
}

export interface InterruptedAutomationRecoveryPorts {
  readonly scheduler: {
    activeJobs(): Promise<readonly { readonly identity: string; readonly jobId: string }[]>;
  };
  readonly evidence: {
    scan(): Promise<InterruptedAutomationEvidence>;
  };
  readonly github: {
    removeIssueLabel(issueNumber: number, label: string): Promise<void>;
    addIssueLabel(issueNumber: number, label: string): Promise<void>;
    addRecoveryDiagnostic(
      issueNumber: number,
      diagnostic: InterruptedAutomationRecoveryDiagnostic,
    ): Promise<void>;
  };
  // Injected so tests control the five-minute grace window deterministically.
  readonly now?: () => number;
}

export interface InterruptedAutomationRecovery {
  // Returns the identities repaired this round so the Dispatcher excludes
  // them from the frontier built from the same discovery snapshot.
  recoverInterrupted(commands: readonly AutomationCommand[]): Promise<readonly string[]>;
}

function recoveryCandidate(command: AutomationCommand): boolean {
  const eligibility = commandEligibility(command);
  if (eligibility !== "stale-in-progress" && eligibility !== "inconsistent") return false;
  if (command.operation === "unknown") {
    // A state-only Work Item has consumed its trigger; it is a candidate only
    // when a single running record can reconstruct the operation below.
    return command.identity.startsWith("issue:") ||
      command.identity.startsWith("spec:") ||
      command.identity.startsWith("pull-request:");
  }
  // A typed command records its route's Target operation in the job log, so
  // candidacy is judged on that recorded operation rather than on the command
  // operation alone: the feedback implementation family types a "implement"
  // command whose recorded operation is implement-feedback.
  const route = resolveAutomationCommandRoute(command.operation, command.number);
  return recoverableOperations.has(route.targetOperation);
}

function parseJobRecord(value: unknown): InterruptedAutomationJobRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  // The jobId shape matches createJobLog so diagnostics stay bounded.
  if (
    typeof candidate.jobId !== "string" ||
    !/^[A-Za-z0-9_-]+$/u.test(candidate.jobId) ||
    typeof candidate.operation !== "string" ||
    typeof candidate.status !== "string" ||
    typeof candidate.startedAt !== "number" ||
    !Number.isFinite(candidate.startedAt) ||
    (candidate.number !== undefined &&
      (typeof candidate.number !== "number" || !Number.isSafeInteger(candidate.number)))
  ) {
    return undefined;
  }
  return {
    jobId: candidate.jobId,
    operation: candidate.operation,
    ...(candidate.number === undefined ? {} : { number: candidate.number }),
    status: candidate.status,
    startedAt: candidate.startedAt,
  };
}

export function createJobLogEvidenceScanner(options: {
  readonly root: string;
}): InterruptedAutomationRecoveryPorts["evidence"] {
  return {
    async scan() {
      let entries;
      try {
        entries = await readdir(options.root, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { records: [], unreadable: [] };
        }
        throw error;
      }
      const records: InterruptedAutomationJobRecord[] = [];
      const unreadable: string[] = [];
      await Promise.all(entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(
              await readFile(join(options.root, entry.name, "metadata.json"), "utf8"),
            );
          } catch {
            unreadable.push(entry.name);
            return;
          }
          const record = parseJobRecord(parsed);
          if (record === undefined) unreadable.push(entry.name);
          else records.push(record);
        }));
      // Deterministic evidence order keeps recovery decisions reproducible.
      records.sort((left, right) => left.jobId.localeCompare(right.jobId));
      unreadable.sort();
      return { records, unreadable };
    },
  };
}

export function createInterruptedAutomationRecovery(
  ports: InterruptedAutomationRecoveryPorts,
): InterruptedAutomationRecovery {
  const attempt = async (
    command: AutomationCommand,
    liveIdentities: ReadonlySet<string>,
    records: readonly InterruptedAutomationJobRecord[],
    now: number,
  ): Promise<string | undefined> => {
    const matches = records.filter((record) =>
      record.status === "running" &&
      record.number === command.number &&
      recoverableOperations.has(record.operation));
    // Zero matches means the evidence is missing; multiple matches means a
    // second interruption left parallel records. Both fail closed.
    if (matches.length !== 1) return undefined;
    const record = matches[0]!;
    // The trigger and Work Item kind come from the recorded Target operation,
    // never from the current labels. The recorded operation is the job log's
    // Target operation, so it resolves through the target-operation route: a
    // recorded implement-feedback operation routes to the agent:implement
    // command trigger on pull-request:<number>.
    const route = resolveTargetOperationRoute(record.operation, record.number);
    if (command.operation !== "unknown") {
      // A typed entry whose present labels routed to a different operation
      // than the one the recorded job was running contradicts the evidence.
      // Identity equality alone cannot detect this: implement-spec and
      // split-spec share the spec:<number> namespace while routing to
      // different triggers, and the pull-request: families (#425) share
      // pull-request:<number> the same way.
      if (command.operation !== route.operation) return undefined;
    } else if (command.labels.some((label) =>
      label !== route.trigger && canonicalAutomationTriggerLabels().includes(label))) {
      // A state-only entry carrying another family trigger contradicts the
      // recorded operation.
      return undefined;
    }
    if (now - record.startedAt < INTERRUPTED_AUTOMATION_GRACE_MILLISECONDS) return undefined;
    if (liveIdentities.has(command.identity) || liveIdentities.has(route.identity)) {
      return undefined;
    }
    await ports.github.removeIssueLabel(command.number, "agent:in-progress");
    const triggerRestored = !command.labels.includes(route.trigger);
    if (triggerRestored) await ports.github.addIssueLabel(command.number, route.trigger);
    await ports.github.addRecoveryDiagnostic(command.number, {
      jobId: record.jobId,
      // The diagnostic names the recorded Target operation (for example
      // implement-feedback) so the bounded message identifies the interrupted
      // job precisely rather than its generic command operation.
      operation: record.operation,
      trigger: route.trigger,
      triggerRestored,
    });
    return command.identity;
  };
  return {
    async recoverInterrupted(commands) {
      const candidates = commands.filter(recoveryCandidate);
      if (candidates.length === 0) return [];
      const [activeJobs, evidence] = await Promise.all([
        ports.scheduler.activeJobs(),
        ports.evidence.scan(),
      ]);
      if (evidence.unreadable.length > 0) return [];
      const liveIdentities = new Set(activeJobs.map((job) => job.identity));
      const now = (ports.now ?? Date.now)();
      const repaired: string[] = [];
      for (const candidate of candidates) {
        const identity = await attempt(candidate, liveIdentities, evidence.records, now);
        if (identity !== undefined) repaired.push(identity);
      }
      return repaired;
    },
  };
}
