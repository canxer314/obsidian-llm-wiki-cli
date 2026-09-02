import { describe, expect, it, vi } from "vitest";

import { createExactLeasePublisher } from "../.sandcastle/exact-lease-publisher.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const REMOTE = "https://github.com/example/repository.git";
const diagnostics = {
  invalidAcquiredRevision: "invalid acquired revision",
  invalidExpectedRevision: "invalid expected revision",
  invalidBranch: "invalid branch",
  checkoutMismatch: "checkout mismatch",
  invalidResultingRevision: "invalid resulting revision",
  invalidRemote: "invalid remote",
} as const;

const createPublisher = (options: {
  readonly execute: ReturnType<typeof vi.fn>;
  readonly sourceRepositoryPath?: string;
  readonly requireNewRevision?: boolean;
}) => createExactLeasePublisher({
  execute: options.execute,
  ...(options.sourceRepositoryPath === undefined
    ? {}
    : { sourceRepositoryPath: options.sourceRepositoryPath }),
  diagnostics,
  revisionPolicy: options.requireNewRevision === true
    ? { requireNewRevision: true, unchangedRevisionDiagnostic: "unchanged revision" }
    : { requireNewRevision: false },
});

describe("exact-lease publisher protocol", () => {
  it.each([
    { branch: "feature/review", revision: "short", diagnostic: diagnostics.invalidAcquiredRevision },
    { branch: "", revision: SHA_A, diagnostic: diagnostics.invalidBranch },
    { branch: "-unsafe", revision: SHA_A, diagnostic: diagnostics.invalidBranch },
    { branch: "feature..unsafe", revision: SHA_A, diagnostic: diagnostics.invalidBranch },
  ])("rejects invalid preparation input before Git execution", async ({ branch, revision, diagnostic }) => {
    const execute = vi.fn();
    const publisher = createPublisher({ execute });

    await expect(publisher.prepare("/checkout", branch, revision)).rejects.toThrow(diagnostic);
    expect(execute).not.toHaveBeenCalled();
  });

  it("checks out the acquired revision and proves the resulting HEAD", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: `${SHA_B}\n`, stderr: "" });
    const publisher = createPublisher({ execute });

    await expect(publisher.prepare("/checkout", "feature/review", SHA_A))
      .rejects.toThrow(diagnostics.checkoutMismatch);
    expect(execute).toHaveBeenNthCalledWith(1, "git", [
      "-C", "/checkout", "checkout", "-B", "feature/review", SHA_A,
    ]);
    expect(execute).toHaveBeenNthCalledWith(2, "git", [
      "-C", "/checkout", "rev-parse", "HEAD",
    ]);
  });

  it.each([
    { branch: "feature/review", expectedRevision: "short", diagnostic: diagnostics.invalidExpectedRevision },
    { branch: "", expectedRevision: SHA_A, diagnostic: diagnostics.invalidBranch },
    { branch: "-unsafe", expectedRevision: SHA_A, diagnostic: diagnostics.invalidBranch },
    { branch: "feature..unsafe", expectedRevision: SHA_A, diagnostic: diagnostics.invalidBranch },
  ])("rejects invalid publication input before Git execution", async ({ branch, expectedRevision, diagnostic }) => {
    const execute = vi.fn();
    const publisher = createPublisher({ execute });

    await expect(publisher.publish({
      checkoutPath: "/checkout",
      branch,
      expectedRevision,
    })).rejects.toThrow(diagnostic);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a malformed resulting revision before remote resolution", async () => {
    const execute = vi.fn().mockResolvedValueOnce({ stdout: "not-a-revision\n", stderr: "" });
    const publisher = createPublisher({ execute });

    await expect(publisher.publish({
      checkoutPath: "/checkout",
      branch: "feature/review",
      expectedRevision: SHA_A,
    })).rejects.toThrow(diagnostics.invalidResultingRevision);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects an unchanged revision under a new-revision policy before remote resolution", async () => {
    const execute = vi.fn().mockResolvedValueOnce({ stdout: `${SHA_A}\n`, stderr: "" });
    const publisher = createPublisher({ execute, requireNewRevision: true });

    await expect(publisher.publish({
      checkoutPath: "/checkout",
      branch: "feature/review",
      expectedRevision: SHA_A,
    })).rejects.toThrow("unchanged revision");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("uses the trusted source origin and pushes HEAD with the exact acquired-revision lease", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: `${SHA_B}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: `${REMOTE}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const publisher = createPublisher({ execute, sourceRepositoryPath: "/trusted/source" });

    await expect(publisher.publish({
      checkoutPath: "/checkout",
      branch: "feature/review",
      expectedRevision: SHA_A,
    })).resolves.toBe(SHA_B);
    expect(execute).toHaveBeenNthCalledWith(2, "git", [
      "-C", "/trusted/source", "remote", "get-url", "origin",
    ]);
    expect(execute).toHaveBeenNthCalledWith(3, "git", [
      "-C", "/checkout", "push", REMOTE,
      `--force-with-lease=refs/heads/feature/review:${SHA_A}`,
      "HEAD:refs/heads/feature/review",
    ]);
  });

  it.each([
    { name: "empty", remote: "\n" },
    { name: "credential-bearing", remote: "https://token@example.test/repository.git\n" },
  ])("rejects a $name remote before push", async ({ remote }) => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: `${SHA_B}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: remote, stderr: "" });
    const publisher = createPublisher({ execute });

    await expect(publisher.publish({
      checkoutPath: "/checkout",
      branch: "feature/review",
      expectedRevision: SHA_A,
    })).rejects.toThrow(diagnostics.invalidRemote);
    expect(execute).toHaveBeenNthCalledWith(2, "git", [
      "-C", "/checkout", "remote", "get-url", "origin",
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("propagates a lease rejection without retrying or returning a revision", async () => {
    const rejection = new Error("stale info");
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: `${SHA_B}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: `${REMOTE}\n`, stderr: "" })
      .mockRejectedValueOnce(rejection);
    const publisher = createPublisher({ execute });

    const publication = publisher.publish({
      checkoutPath: "/checkout",
      branch: "feature/review",
      expectedRevision: SHA_A,
    });
    await expect(publication).rejects.toBe(rejection);
    expect(execute).toHaveBeenCalledTimes(3);
  });
});
