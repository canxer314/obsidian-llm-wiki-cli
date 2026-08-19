import { describe, expect, it } from "vitest";

import { isCanonicalVaultPath } from "../src/canonical-vault-path.js";

describe("isCanonicalVaultPath", () => {
  it("rejects paths containing NUL characters", () => {
    expect(isCanonicalVaultPath("Notes/a\0.md")).toBe(false);
  });

  it("accepts existing valid canonical paths", () => {
    expect(isCanonicalVaultPath("Notes/设计.md")).toBe(true);
  });
});
