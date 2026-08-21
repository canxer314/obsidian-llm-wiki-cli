import { describe, expect, it, vi } from "vitest";

import { createSameSessionPrdSplitExtractor } from "../.sandcastle/prd-split-extraction.js";

describe("same-session PRD split extraction", () => {
  it("runs one unconstrained split pass, then uses bounded same-session structured extraction", async () => {
    const resume = vi.fn().mockResolvedValue({
      commits: [],
      output: { slices: [{ title: "Create slice", whatToBuild: "Deliver a complete path.", acceptanceCriteria: ["It works"] }] },
    });
    const runAgent = vi.fn().mockResolvedValue({ commits: [], resume });
    const splitter = createSameSessionPrdSplitExtractor({
      sandbox: { kind: "fake-sandbox" } as never,
      hooks: { sandbox: { onSandboxReady: [] } },
      runAgent: runAgent as never,
      createAgent: vi.fn().mockReturnValue({ name: "fake-splitter" }) as never,
    });

    await expect(splitter.split({
      prdNumber: 223,
      title: "Split a PRD",
      checkoutPath: "/safe/disposable-checkout",
      model: "splitter-model",
    })).resolves.toEqual([{ title: "Create slice", whatToBuild: "Deliver a complete path.", acceptanceCriteria: ["It works"] }]);

    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/safe/disposable-checkout", maxIterations: 1 }));
    expect(runAgent.mock.calls[0]![0].prompt).toContain("gh issue view 223 --comments");
    expect(runAgent.mock.calls[0]![0].prompt).not.toContain("<output>");
    expect(resume).toHaveBeenCalledWith(expect.stringContaining("<output>"), {
      output: expect.objectContaining({ _tag: "object", tag: "output", maxRetries: 2 }),
    });
  });

  it("fails closed rather than rerunning a non-resumable production pass", async () => {
    const splitter = createSameSessionPrdSplitExtractor({
      sandbox: { kind: "fake-sandbox" } as never,
      hooks: { sandbox: { onSandboxReady: [] } },
      runAgent: vi.fn().mockResolvedValue({ commits: [] }) as never,
      createAgent: vi.fn().mockReturnValue({ name: "fake-splitter" }) as never,
    });

    await expect(splitter.split({
      prdNumber: 223,
      title: "Split a PRD",
      checkoutPath: "/safe/disposable-checkout",
      model: "splitter-model",
    })).rejects.toThrow("PRD splitter session identity is unavailable");
  });
});
