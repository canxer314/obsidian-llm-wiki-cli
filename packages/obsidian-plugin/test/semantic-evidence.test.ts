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
      probes: {
        cacheVisible: async () => false,
        referenced: async () => false,
      },
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

  it("fails closed when hidden trash evidence has no probes configured", async () => {
    let now = 0;
    let snapshots = 0;
    const tracker = createChangeSetSemanticEvidenceTracker({
      deadlineMs: 5_000,
      now: () => now,
      delay: async (milliseconds) => {
        now += milliseconds;
      },
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
    await expect(tracker.await(evidence)).rejects.toThrow(
      "Change Set semantic evidence timed out",
    );
    expect(now).toBe(5_000);
    expect(snapshots).toBe(0);
  });

  it("waits for targeted cache/reference probes before publishing the successor snapshot", async () => {
    let now = 0;
    let cacheCleared = false;
    const published: string[] = [];
    const tracker = createChangeSetSemanticEvidenceTracker({
      deadlineMs: 5_000,
      now: () => now,
      delay: async (milliseconds) => {
        now += milliseconds;
        // Obsidian finishes evicting the trashed note while the barrier waits.
        cacheCleared = true;
      },
      probes: {
        cacheVisible: async () => !cacheCleared,
        referenced: async () => !cacheCleared,
      },
      publishSuccessorSearchSnapshot: async () => {
        published.push("snapshot");
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

    expect(now).toBeGreaterThan(0);
    expect(published).toEqual(["snapshot"]);
  });

  it("fails closed when cache/reference probes never confirm hidden trash", async () => {
    let now = 0;
    let snapshots = 0;
    const tracker = createChangeSetSemanticEvidenceTracker({
      deadlineMs: 5_000,
      now: () => now,
      delay: async (milliseconds) => {
        now += milliseconds;
      },
      probes: {
        // The metadata cache keeps serving the trashed note: the barrier must
        // not report success on raw path state alone.
        cacheVisible: async () => true,
        referenced: async () => false,
      },
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
    await expect(tracker.await(evidence)).rejects.toThrow(
      "Change Set semantic evidence timed out",
    );
    expect(now).toBe(5_000);
    expect(snapshots).toBe(0);
  });

  it("requires the metadata cache to observe a restored note before recovery succeeds", async () => {
    let now = 0;
    let reindexed = false;
    const published: string[] = [];
    const tracker = createChangeSetSemanticEvidenceTracker({
      deadlineMs: 5_000,
      now: () => now,
      delay: async (milliseconds) => {
        now += milliseconds;
        reindexed = true;
      },
      probes: {
        cacheVisible: async () => reindexed,
        referenced: async () => false,
      },
      publishSuccessorSearchSnapshot: async () => {
        published.push("snapshot");
      },
    });
    const evidence = {
      mode: "restore" as const,
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

    expect(reindexed).toBe(true);
    expect(published).toEqual(["snapshot"]);
  });

  it("probes references but not the Markdown cache for attachment trash", async () => {
    const seen: string[] = [];
    const tracker = createChangeSetSemanticEvidenceTracker({
      probes: {
        cacheVisible: async (path) => {
          seen.push(`cache:${path}`);
          return true;
        },
        referenced: async (path) => {
          seen.push(`refs:${path}`);
          return false;
        },
      },
      publishSuccessorSearchSnapshot: async () => undefined,
    });
    const evidence = {
      mode: "apply" as const,
      operations: [{
        operationId: "trash-1",
        kind: "trash" as const,
        path: "assets/image.png",
        expectedSha256: "b".repeat(64),
      }],
      publicPaths: ["assets/image.png"],
      hiddenTrash: true,
      requiredEvents: [],
    };

    tracker.begin(evidence);
    await tracker.await(evidence);

    expect(seen).toEqual(["refs:assets/image.png"]);
  });
});
