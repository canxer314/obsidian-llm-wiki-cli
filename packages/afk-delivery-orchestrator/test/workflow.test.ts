import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const workflowPath = new URL("../../../.github/workflows/afk-delivery.yml", import.meta.url);

describe("AFK Delivery workflow contract", () => {
  it("uses scheduled and manual triggers with the same bounded dispatch path", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("schedule:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("fromJSON(needs.discover.outputs.tickets)");
    expect(workflow).toContain("max-parallel: 4");
  });

  it("uses Actions concurrency as the Delivery Lease without cancelling active work", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("group: afk-delivery-${{ github.repository }}-ticket-${{ matrix.ticket }}");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).not.toMatch(/add-label|remove-label|claim-comment/u);
  });

  it("keeps GitHub authority in orchestration and supplies explicit implementation bounds", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    const implementation = workflow.indexOf("name: Implement and publish Managed PR");

    expect(implementation).toBeGreaterThan(workflow.indexOf("name: Dispatch one bounded transition"));
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("pull-requests: write");
    expect(workflow).not.toContain("AFK_CLAUDE_SETTINGS:");
    expect(workflow).toContain("AFK_MODEL: fable");
    expect(workflow).toContain('AFK_CONTEXT_WINDOW: "372000"');
    expect(workflow).toContain('AFK_MAX_ITERATIONS: "24"');
    expect(workflow).toContain('AFK_STAGE_TIMEOUT_MS: "3600000"');
    expect(workflow).toContain('AFK_STAGE_CPUS: "2"');
  });

  it("runs preflight before fresh reconstruction and bounded transition dispatch", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    const preflight = workflow.indexOf("name: Worker preflight");
    const reconstruct = workflow.indexOf("name: Reconstruct current GitHub state");
    const transition = workflow.indexOf("name: Dispatch one bounded transition");

    expect(preflight).toBeGreaterThan(0);
    expect(reconstruct).toBeGreaterThan(preflight);
    expect(transition).toBeGreaterThan(reconstruct);
  });
});
