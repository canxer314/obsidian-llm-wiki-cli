import { createHash } from "node:crypto";

export interface StandardDiagnosticSource {
  generatedAt: string;
  correlationSalt: string;
  versions: {
    bridge: string;
    plugin: string;
    protocol: string;
    persistentStateSchema: number;
    recoveryJournalSchema: number;
  };
  health: {
    overall: "healthy" | "degraded" | "blocked";
    reasonCodes: readonly string[];
    operatorAction: string;
  };
  listenerTimeline: readonly {
    at: string;
    state: string;
    listenerId: string;
  }[];
  queueTimeline: readonly {
    at: string;
    state: string;
    queueLength: number;
    changeSetId?: string;
    submissionKey?: string;
  }[];
  lifecycle: {
    startup: string;
    upgrade: string;
    migration: string;
    recovery: string;
  };
  journal: {
    state: "absent" | "readable" | "unreadable" | "incompatible";
    phase?: string;
    sequence?: number;
    checksum: "valid" | "invalid" | "unavailable";
    changeSetId?: string;
  };
  logs: readonly { at: string; level: string; code: string }[];
  stacks: readonly { code: string; frames: readonly string[] }[];
}

export interface StandardDiagnosticBundle {
  format: "llm-wiki-standard-diagnostics-v1";
  generatedAt: string;
  versions: StandardDiagnosticSource["versions"];
  health: StandardDiagnosticSource["health"];
  listenerTimeline: readonly {
    at: string;
    state: string;
    listenerAlias: string;
  }[];
  queueTimeline: readonly {
    at: string;
    state: string;
    queueLength: number;
    changeSetAlias?: string;
    submissionKeyDigest?: string;
  }[];
  lifecycle: StandardDiagnosticSource["lifecycle"];
  journal: {
    state: StandardDiagnosticSource["journal"]["state"];
    phase?: string;
    sequence?: number;
    checksum: StandardDiagnosticSource["journal"]["checksum"];
    changeSetAlias?: string;
  };
  logs: StandardDiagnosticSource["logs"];
  stacks: StandardDiagnosticSource["stacks"];
  checksum: string;
}

const sourceKeys = [
  "correlationSalt",
  "generatedAt",
  "health",
  "journal",
  "lifecycle",
  "listenerTimeline",
  "logs",
  "queueTimeline",
  "stacks",
  "versions",
].sort();

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function alias(kind: string, value: string, salt: string): string {
  return `${kind}-${createHash("sha256")
    .update(`${salt}\0${kind}\0${value}`, "utf8")
    .digest("hex")
    .slice(0, 12)}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, member]) => [key, canonicalize(member)]),
  );
}

export interface ContentInclusiveDiagnosticAuthorization {
  confirmedByPrimaryOperator: boolean;
  source: "local_interactive" | "agent";
}

export interface ContentInclusiveDiagnosticData {
  format: "llm-wiki-content-diagnostics-v1";
  selections: readonly { label: string; content: string }[];
}

export function createContentInclusiveDiagnosticData(
  authorization: ContentInclusiveDiagnosticAuthorization,
  selections: readonly { label: string; content: string }[],
): ContentInclusiveDiagnosticData {
  if (
    authorization.source !== "local_interactive" ||
    authorization.confirmedByPrimaryOperator !== true
  ) {
    throw new Error(
      "Content-inclusive diagnostics require a local interactive Primary Operator confirmation",
    );
  }
  return {
    format: "llm-wiki-content-diagnostics-v1",
    selections: structuredClone(selections),
  };
}

function assertMachineCode(value: string, field: string): void {
  if (!/^[a-z][a-z0-9_.-]*$/u.test(value)) {
    throw new TypeError(`${field} must be a machine code`);
  }
}

export function createStandardDiagnosticBundle(
  source: StandardDiagnosticSource,
): StandardDiagnosticBundle {
  const actualKeys = Object.keys(source).sort();
  if (actualKeys.join(",") !== sourceKeys.join(",")) {
    throw new TypeError("unknown diagnostic source field");
  }
  if (source.correlationSalt.length === 0) {
    throw new TypeError("diagnostic correlation salt must not be empty");
  }
  for (const code of source.health.reasonCodes) assertMachineCode(code, "reason code");
  assertMachineCode(source.health.operatorAction, "operator action");
  for (const record of source.logs) {
    assertMachineCode(record.level, "log level");
    assertMachineCode(record.code, "log code");
  }
  for (const stack of source.stacks) {
    assertMachineCode(stack.code, "stack code");
    for (const frame of stack.frames) {
      if (!/^[A-Za-z_$][A-Za-z0-9_$.<>-]*$/u.test(frame)) {
        throw new TypeError("stack frame must be a symbol without a path");
      }
    }
  }

  const payload = {
    format: "llm-wiki-standard-diagnostics-v1" as const,
    generatedAt: source.generatedAt,
    versions: structuredClone(source.versions),
    health: structuredClone(source.health),
    listenerTimeline: source.listenerTimeline.map(({ listenerId, ...entry }) => ({
      ...entry,
      listenerAlias: alias("listener", listenerId, source.correlationSalt),
    })),
    queueTimeline: source.queueTimeline.map(
      ({ changeSetId, submissionKey, ...entry }) => ({
        ...entry,
        ...(changeSetId === undefined
          ? {}
          : { changeSetAlias: alias("change-set", changeSetId, source.correlationSalt) }),
        ...(submissionKey === undefined
          ? {}
          : { submissionKeyDigest: sha256(`${source.correlationSalt}\0${submissionKey}`) }),
      }),
    ),
    lifecycle: structuredClone(source.lifecycle),
    journal: {
      state: source.journal.state,
      ...(source.journal.phase === undefined ? {} : { phase: source.journal.phase }),
      ...(source.journal.sequence === undefined ? {} : { sequence: source.journal.sequence }),
      checksum: source.journal.checksum,
      ...(source.journal.changeSetId === undefined
        ? {}
        : {
            changeSetAlias: alias(
              "change-set",
              source.journal.changeSetId,
              source.correlationSalt,
            ),
          }),
    },
    logs: structuredClone(source.logs),
    stacks: structuredClone(source.stacks),
  };
  return {
    ...payload,
    checksum: sha256(JSON.stringify(canonicalize(payload))),
  };
}
