import { classifyAgentStreamEvent } from "./agent-activity.ts";

export const SANDCASTLE_WORKFLOW_STAGES = [
  "startup",
  "planner",
  "implementer",
  "local-quality",
  "target-sync",
  "reviewer",
  "repair",
  "merger",
  "merge",
  "terminal",
] as const;

export type SandcastleWorkflowStage = typeof SANDCASTLE_WORKFLOW_STAGES[number];
export type SandcastleRole = "planner" | "implementer" | "reviewer" | "merger";
export type SandcastleHealth = "active" | "warning" | "completed" | "failed";
export type SandcastleObservedActivity =
  | "starting"
  | "waiting"
  | "inspecting-repository"
  | "editing"
  | "executing-command"
  | "executing-other-tool"
  | "completed";
export type SandcastleWarning =
  | "agent-idle"
  | "planner-over-soft-limit"
  | "implementer-over-soft-limit"
  | "reviewer-over-soft-limit"
  | "repair-over-soft-limit"
  | "merger-over-soft-limit"
  | "workflow-over-soft-limit";
export type SandcastleStatusFormat = "human" | "json";

export interface SandcastleLiveStatusPort {
  transition(stage: SandcastleWorkflowStage): void;
  observeAgentEvent(event: unknown): void;
}

export interface SandcastleLiveStatusEvent {
  readonly version: 1;
  readonly kind: "transition" | "heartbeat";
  readonly runId: string;
  readonly batchId: number;
  readonly issueNumber: number;
  readonly timestamp: string;
  readonly elapsedMs: number;
  readonly sequence: number;
  readonly workflowStage: SandcastleWorkflowStage;
  readonly role: SandcastleRole | null;
  readonly health: SandcastleHealth;
  readonly lastObservedActivity: SandcastleObservedActivity | null;
  readonly activityAgeMs: number | null;
  readonly stageElapsedMs: number;
  readonly warning: SandcastleWarning | null;
}

export interface SandcastleIdleStatusEvent {
  readonly version: 1;
  readonly kind: "idle";
  readonly runId: string;
  readonly batchId: number;
  readonly issueNumber: null;
  readonly timestamp: string;
  readonly elapsedMs: number;
  readonly sequence: number;
  readonly workflowStage: null;
  readonly role: null;
  readonly health: null;
  readonly lastObservedActivity: null;
  readonly activityAgeMs: null;
  readonly stageElapsedMs: 0;
  readonly warning: null;
}

export type SandcastleStatusEvent = SandcastleLiveStatusEvent | SandcastleIdleStatusEvent;

type IntervalHandle = unknown;

export interface SandcastleLiveStatusDependencies {
  readonly sink?: (line: string) => void;
  readonly warningSink?: (line: string) => void;
  readonly monotonicNow?: () => number;
  readonly utcNow?: () => Date;
  readonly isTty?: () => boolean;
  readonly setInterval?: (callback: () => void, milliseconds: number) => IntervalHandle;
  readonly clearInterval?: (handle: IntervalHandle) => void;
}

interface ActiveStatus {
  readonly batchId: number;
  readonly issueNumber: number;
  readonly startedAt: number;
  stageStartedAt: number;
  workflowStage: SandcastleWorkflowStage;
  role: SandcastleRole | null;
  health: SandcastleHealth;
  lastObservedActivity: SandcastleObservedActivity | null;
  lastActivityAt: number | null;
  readonly warnings: Set<SandcastleWarning>;
  stageWarning: SandcastleWarning | null;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const AGENT_IDLE_MS = 5 * 60_000;
const WORKFLOW_SOFT_LIMIT_MS = 12 * 60 * 60_000;
const STAGE_SOFT_LIMITS: Partial<Record<SandcastleWorkflowStage, number>> = {
  planner: 15 * 60_000,
  implementer: 75 * 60_000,
  reviewer: 30 * 60_000,
  repair: 60 * 60_000,
  merger: 45 * 60_000,
};
const STATUS_WARNING = "Sandcastle live status disabled after output failure";

function roleFor(stage: SandcastleWorkflowStage): SandcastleRole | null {
  switch (stage) {
    case "planner":
      return "planner";
    case "implementer":
    case "repair":
      return "implementer";
    case "reviewer":
      return "reviewer";
    case "merger":
      return "merger";
    default:
      return null;
  }
}

function renderJson(event: SandcastleStatusEvent): string {
  return JSON.stringify({ sandcastleStatus: event });
}

function renderHuman(event: SandcastleStatusEvent): string {
  const prefix = `[sandcastle ${event.sequence} ${event.timestamp} +${event.elapsedMs}ms]`;
  if (event.kind === "idle") return `${prefix} run=${event.runId} idle`;
  const role = event.role === null ? "" : ` role=${event.role}`;
  return `${prefix} run=${event.runId} issue=#${event.issueNumber} ${event.kind} stage=${event.workflowStage}${role} health=${event.health}`;
}

export interface SandcastleLiveStatusRegistry {
  readonly startIssue: (batchId: number, issueNumber: number) => SandcastleLiveStatusPort;
  readonly finishIssue: (issueNumber: number, outcome: "completed" | "failed") => void;
  readonly idle: (batchId: number) => void;
  readonly dispose: () => void;
}

const NOOP_PORT: SandcastleLiveStatusPort = { transition() {}, observeAgentEvent() {} };
const NOOP_REGISTRY: SandcastleLiveStatusRegistry = {
  startIssue: () => NOOP_PORT,
  finishIssue() {},
  idle() {},
  dispose() {},
};

export function createSandcastleLiveStatus(options: {
  readonly runId: string;
  readonly format?: SandcastleStatusFormat;
  readonly enabled?: boolean;
  readonly dependencies?: SandcastleLiveStatusDependencies;
}): SandcastleLiveStatusRegistry {
  if (options.enabled === false) return NOOP_REGISTRY;

  const dependencies = options.dependencies ?? {};
  const warningSink = dependencies.warningSink ?? ((line: string) => console.error(line));
  const warn = () => {
    try {
      warningSink(STATUS_WARNING);
    } catch {
      // Live status must never affect workflow behavior.
    }
  };
  const sink = dependencies.sink ?? ((line: string) => console.error(line));
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const utcNow = dependencies.utcNow ?? (() => new Date());
  const schedule = dependencies.setInterval ?? ((callback, milliseconds) =>
    setInterval(callback, milliseconds));
  const cancel = dependencies.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
  let format: SandcastleStatusFormat;
  let startedAt: number;
  try {
    format = options.format ?? ((dependencies.isTty ?? (() => process.stderr.isTTY === true))()
      ? "human"
      : "json");
    startedAt = monotonicNow();
  } catch {
    warn();
    return NOOP_REGISTRY;
  }
  const active = new Map<number, ActiveStatus>();
  let sequence = 0;
  let disabled = false;
  let warned = false;
  let heartbeat: IntervalHandle | undefined;

  const disable = () => {
    disabled = true;
    if (heartbeat !== undefined) {
      try {
        cancel(heartbeat);
      } catch {
        // Live status must never affect workflow behavior.
      }
      heartbeat = undefined;
    }
    if (warned) return;
    warned = true;
    warn();
  };

  const emit = (event: Omit<SandcastleStatusEvent, "version" | "timestamp" | "sequence">) => {
    if (disabled) return;
    try {
      const complete = {
        version: 1 as const,
        ...event,
        timestamp: utcNow().toISOString(),
        sequence: ++sequence,
      } as SandcastleStatusEvent;
      sink(format === "human" ? renderHuman(complete) : renderJson(complete));
    } catch {
      disable();
    }
  };

  const emitActive = (
    status: ActiveStatus,
    kind: "transition" | "heartbeat",
    warning: SandcastleWarning | null = null,
  ) => {
    try {
      const now = monotonicNow();
      emit({
        kind,
        runId: options.runId,
        batchId: status.batchId,
        issueNumber: status.issueNumber,
        elapsedMs: Math.max(0, Math.floor(now - status.startedAt)),
        workflowStage: status.workflowStage,
        role: status.role,
        health: status.health,
        lastObservedActivity: status.lastObservedActivity,
        activityAgeMs: status.lastActivityAt === null
          ? null
          : Math.max(0, Math.floor(now - status.lastActivityAt)),
        stageElapsedMs: Math.max(0, Math.floor(now - status.stageStartedAt)),
        warning,
      });
    } catch {
      disable();
    }
  };

  const emitWarning = (status: ActiveStatus, warning: SandcastleWarning) => {
    if (status.warnings.has(warning)) return;
    status.warnings.add(warning);
    status.health = "warning";
    emitActive(status, "transition", warning);
  };

  const checkWarnings = (status: ActiveStatus) => {
    const now = monotonicNow();
    if (status.lastActivityAt !== null && now - status.lastActivityAt >= AGENT_IDLE_MS) {
      emitWarning(status, "agent-idle");
    }
    const stageLimit = STAGE_SOFT_LIMITS[status.workflowStage];
    if (stageLimit !== undefined && now - status.stageStartedAt >= stageLimit) {
      const warning = `${status.workflowStage}-over-soft-limit` as SandcastleWarning;
      status.stageWarning = warning;
      emitWarning(status, warning);
    }
    if (now - status.startedAt >= WORKFLOW_SOFT_LIMIT_MS) {
      emitWarning(status, "workflow-over-soft-limit");
    }
  };

  const ensureHeartbeat = () => {
    if (disabled || heartbeat !== undefined || active.size === 0) return;
    try {
      heartbeat = schedule(() => {
        try {
          for (const status of active.values()) {
            checkWarnings(status);
            emitActive(status, "heartbeat");
          }
        } catch {
          disable();
        }
      }, HEARTBEAT_INTERVAL_MS);
    } catch {
      disable();
    }
  };

  const stopHeartbeatIfIdle = () => {
    if (active.size !== 0 || heartbeat === undefined) return;
    try {
      cancel(heartbeat);
    } catch {
      disable();
    }
    heartbeat = undefined;
  };

  return {
    startIssue(batchId, issueNumber) {
      let issueStartedAt: number;
      try {
        issueStartedAt = monotonicNow();
      } catch {
        disable();
        return NOOP_PORT;
      }
      const status: ActiveStatus = {
        batchId,
        issueNumber,
        startedAt: issueStartedAt,
        stageStartedAt: issueStartedAt,
        workflowStage: "startup",
        role: null,
        health: "active",
        lastObservedActivity: null,
        lastActivityAt: null,
        warnings: new Set(),
        stageWarning: null,
      };
      active.set(issueNumber, status);
      emitActive(status, "transition");
      ensureHeartbeat();
      return {
        transition(stage) {
          if (!active.has(issueNumber) || status.workflowStage === stage) return;
          status.workflowStage = stage;
          status.role = roleFor(stage);
          status.stageStartedAt = monotonicNow();
          if (status.stageWarning !== null) status.warnings.delete(status.stageWarning);
          status.stageWarning = null;
          status.health = status.warnings.size === 0 ? "active" : "warning";
          emitActive(status, "transition");
        },
        observeAgentEvent(event) {
          if (!active.has(issueNumber)) return;
          const activity = classifyAgentStreamEvent(event);
          const now = monotonicNow();
          status.lastActivityAt = now;
          const nextActivity = activity ?? status.lastObservedActivity ?? "starting";
          if (status.lastObservedActivity === nextActivity) return;
          status.lastObservedActivity = nextActivity;
          emitActive(status, "transition");
        },
      };
    },
    finishIssue(issueNumber, outcome) {
      const status = active.get(issueNumber);
      if (status === undefined) return;
      status.workflowStage = "terminal";
      status.role = null;
      status.health = outcome;
      status.lastObservedActivity = "completed";
      emitActive(status, "transition");
      active.delete(issueNumber);
      stopHeartbeatIfIdle();
    },
    idle(batchId) {
      if (active.size !== 0 || disabled) return;
      let elapsedMs: number;
      try {
        elapsedMs = Math.max(0, Math.floor(monotonicNow() - startedAt));
      } catch {
        disable();
        return;
      }
      emit({
        kind: "idle",
        runId: options.runId,
        batchId,
        issueNumber: null,
        elapsedMs,
        workflowStage: null,
        role: null,
        health: null,
        lastObservedActivity: null,
        activityAgeMs: null,
        stageElapsedMs: 0,
        warning: null,
      });
    },
    dispose() {
      if (heartbeat === undefined) return;
      try {
        cancel(heartbeat);
      } catch {
        disable();
      }
      heartbeat = undefined;
    },
  };
}
