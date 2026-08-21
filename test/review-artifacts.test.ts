import { mkdtemp, mkdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createReviewArtifactDirectory, removeExpiredReviewArtifacts } from "../.sandcastle/review-artifacts.js";

const roots: string[] = [];
const sevenDays = 7 * 24 * 60 * 60 * 1000;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("review artifacts", () => {
  it("creates a restricted job directory from a safe job identifier", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-artifacts-"));
    roots.push(root);

    await expect(createReviewArtifactDirectory({ root, jobId: "pr-220-0123456789ab" }))
      .resolves.toBe(join(root, "pr-220-0123456789ab"));
    await expect(createReviewArtifactDirectory({ root, jobId: "../escape" }))
      .rejects.toThrow("Review artifact job ID is invalid");
  });

  it("removes only failed job directories older than seven days", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-artifacts-"));
    roots.push(root);
    const expired = join(root, "review-220-expired");
    const retained = join(root, "review-220-recent");
    await Promise.all([mkdir(expired), mkdir(retained)]);
    const now = Date.UTC(2026, 7, 21);
    await utimes(expired, new Date(now - sevenDays - 1), new Date(now - sevenDays - 1));

    await removeExpiredReviewArtifacts({ root, now });

    await expect(import("node:fs/promises").then(({ stat }) => stat(expired))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(import("node:fs/promises").then(({ stat }) => stat(retained))).resolves.toBeDefined();
  });
});
