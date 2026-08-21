import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { acquireImplementationLease, acquirePullRequestLease } from "../.sandcastle/implementation-lease.js";

describe("implementation lease", () => {
  it("atomically grants one lease per Issue and releases it for retry", async () => {
    const root = await mkdtemp(`${tmpdir()}/implementation-lease-`);
    try {
      const [first, second] = await Promise.all([
        acquireImplementationLease({ root, issueNumber: 221 }),
        acquireImplementationLease({ root, issueNumber: 221 }),
      ]);
      const lease = first ?? second;

      expect(lease).toBeDefined();
      expect(first === undefined || second === undefined).toBe(true);

      await lease!.release();
      const retry = await acquireImplementationLease({ root, issueNumber: 221 });
      expect(retry).toBeDefined();
      await retry!.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("automatically releases the lease when its owning process exits", async () => {
    const root = await mkdtemp(`${tmpdir()}/implementation-lease-`);
    try {
      const lease = await acquireImplementationLease({ root, issueNumber: 221 });
      expect(lease).toBeDefined();
      await lease!.release();
      await expect(acquireImplementationLease({ root, issueNumber: 221 })).resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("grants one shared lease per Pull Request", async () => {
    const root = await mkdtemp(`${tmpdir()}/implementation-lease-`);
    try {
      const first = await acquirePullRequestLease({ root, pullRequestNumber: 224 });
      expect(first).toBeDefined();
      await expect(acquirePullRequestLease({ root, pullRequestNumber: 224 })).resolves.toBeUndefined();
      await first!.release();
      const retry = await acquirePullRequestLease({ root, pullRequestNumber: 224 });
      expect(retry).toBeDefined();
      await retry!.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid lease numbers before changing the filesystem", async () => {
    await expect(acquirePullRequestLease({ root: "/unused", pullRequestNumber: 0 }))
      .rejects.toThrow("Pull Request lease number is invalid");
    await expect(acquireImplementationLease({ root: "/unused", issueNumber: 0 }))
      .rejects.toThrow("Implementation lease Issue number is invalid");
  });
});
