import { describe, expect, it } from "vitest";

import { diagnosticSummary } from "../.sandcastle/redaction.js";

describe("diagnosticSummary", () => {
  it("redacts file URLs while preserving the diagnostic wording", () => {
    const summary = diagnosticSummary(
      "Target job failed at file:///tmp/target-failure-359/checkout/.sandcastle/operations/foo.ts:162; retry manually",
    );

    expect(summary).toContain("Target job failed at [LOCAL_PATH]; retry manually");
    expect(summary).not.toContain("file://");
    expect(summary).not.toContain("/tmp");
    expect(summary).not.toContain("target-failure-359");
    expect(summary).not.toContain("checkout");
    expect(summary).not.toContain("foo.ts");
  });

  it("redacts non-absolute file URLs without redacting https URLs", () => {
    expect(diagnosticSummary("worker failed at file://localhost/tmp/foo.ts:162")).toBe(
      "worker failed at [LOCAL_PATH]",
    );
    expect(diagnosticSummary("worker failed at https://example.test/tmp/foo.ts:162")).toBe(
      "worker failed at https://example.test/tmp/foo.ts:162",
    );
  });

  it("retains bare path, secret, first-line, and length protections", () => {
    const summary = diagnosticSummary(
      `worker failed at /tmp/checkout/.sandcastle/operations/foo.ts:162 with token=ghp_${"a".repeat(36)}\nprivate follow-up`,
    );

    expect(summary).toContain("worker failed at [LOCAL_PATH] with token=[REDACTED]");
    expect(summary).not.toContain("/tmp");
    expect(summary).not.toContain("ghp_");
    expect(summary).not.toContain("private follow-up");
    expect(diagnosticSummary("x".repeat(501))).toHaveLength(500);
  });
});
