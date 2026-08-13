import { describe, expect, it } from "vitest";

import {
  createChangeSetSemanticEvidenceTracker,
  type ChangeSetSemanticEvidenceTrackerOptions,
} from "../src/index.js";

function request(requiredEvents: readonly ({ kind: "create" | "delete"; path: string } | { kind: "rename"; oldPath: string; path: string })[] = []) {
  return {
    mode: "apply" as const,
    operations: [{
      operationId: "copy-1",
      kind: "copy_attachment" as const,
      sourcePath: "assets/source.bin",
      destinationPath: "assets/copy.bin",
      expectedSha256: "a".repeat(64),
    }],
    publicPaths: ["assets/copy.bin", "assets/source.bin"],
    hiddenTrash: false,
    requiredEvents,
  };
}

describe("Change Set semantic evidence tracker", () => {
  it("accepts only the exact required Vault event before publishing the successor snapshot", async () => {
    const events: string[] = [];
    const tracker = createChangeSetSemanticEvidenceTracker({
      publishSuccessorSearchSnapshot: async () => {
        events.push("snapshot");
      },
    });
    const evidence = request([{ kind: "create", path: "assets/copy.bin" }]);

    tracker.begin(evidence);
    tracker.record({ kind: "create", path: "unrelated.bin" });
    tracker.record({ kind: "create", path: "assets/copy.bin" });
    await tracker.await(evidence);

    expect(events).toEqual(["snapshot"]);
  });

  it("does not let an unrelated Vault event satisfy the required event", async () => {
    let now = 0;
    const tracker = createChangeSetSemanticEvidenceTracker({
      deadlineMs: 5_000,
      now: () => now,
      delay: async (milliseconds) => {
        now += milliseconds;
      },
      publishSuccessorSearchSnapshot: async () => undefined,
    });
    const evidence = request([{ kind: "create", path: "assets/copy.bin" }]);

    tracker.begin(evidence);
    tracker.record({ kind: "create", path: "unrelated.bin" });

    await expect(tracker.await(evidence)).rejects.toThrow(
      "Change Set semantic evidence timed out",
    );
  });

  it("fails closed at the evidence deadline when the required event never arrives", async () => {
    let now = 0;
    const options: ChangeSetSemanticEvidenceTrackerOptions = {
      deadlineMs: 5_000,
      now: () => now,
      delay: async (milliseconds) => {
        now += milliseconds;
      },
      publishSuccessorSearchSnapshot: async () => undefined,
    };
    const tracker = createChangeSetSemanticEvidenceTracker(options);
    const evidence = request([{ kind: "create", path: "assets/copy.bin" }]);

    tracker.begin(evidence);

    await expect(tracker.await(evidence)).rejects.toThrow(
      "Change Set semantic evidence timed out",
    );
    expect(now).toBe(5_000);
  });

  it("uses targeted snapshot evidence for hidden trash without requiring a generic Vault event", async () => {
    let snapshots = 0;
    const tracker = createChangeSetSemanticEvidenceTracker({
      publishSuccessorSearchSnapshot: async () => {
        snapshots += 1;
      },
    });
    const evidence = {
      mode: "apply" as const,
      operations: [{
        operationId: "trash-1",
        kind: "trash" as const,
        path: "Note.md",
        targetVersion: `sha256:${"a".repeat(64)}`,
      }],
      publicPaths: ["Note.md"],
      hiddenTrash: true,
      requiredEvents: [],
    };

    tracker.begin(evidence);
    await tracker.await(evidence);

    expect(snapshots).toBe(1);
  });
});
