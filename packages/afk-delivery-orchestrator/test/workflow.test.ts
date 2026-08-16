import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const workflowPath = new URL("../../../.github/workflows/afk-delivery.yml", import.meta.url);
const prWorkflowPath = new URL("../../../.github/workflows/pr-quality.yml", import.meta.url);
const smokePath = new URL("../../../.sandcastle/smoke.sh", import.meta.url);
const deliveryDockerfilePath = new URL("../../../.sandcastle/Dockerfile", import.meta.url);
const packagePath = new URL("../../../package.json", import.meta.url);

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
    const implementation = workflow.indexOf("name: Implement or continue Managed PR");

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

  it("authenticates bounded Managed PR recovery during discovery", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    const discovery = workflow.slice(
      workflow.indexOf("name: Discover Delivery Frontier"),
      workflow.indexOf("\n\n  deliver:"),
    );

    expect(discovery).toContain("AFK_DELIVERY_ACTOR:");
    expect(discovery).toContain("AFK_DELIVERY_ACTOR_TYPE:");
    expect(discovery).toContain("AFK_TARGET_BRANCH: master");
    expect(discovery).toContain("AFK_RECOVERY_SCAN_LIMIT:");
    expect(workflow).not.toMatch(/if:.*(?:managed|synchroniz|continu)/iu);
  });

  it("uses repository-root paths for the delivery image build context", async () => {
    const dockerfile = await readFile(deliveryDockerfilePath, "utf8");
    const packageDocument = JSON.parse(await readFile(packagePath, "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(packageDocument.scripts["sandcastle:docker:build"]).toContain("-f .sandcastle/Dockerfile .");
    for (const path of ["verify-integrity.mjs", "skills.lock", "skills", "entrypoint.mjs", "verify-model.mjs"]) {
      expect(dockerfile).toContain(`COPY .sandcastle/${path} `);
    }
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

  it("mints a fresh repository installation token for discovery and bounded delivery", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow.match(/afk-delivery app-token/gu)).toHaveLength(2);
    expect(workflow).not.toContain("AFK_GITHUB_APP_PRIVATE_KEY");
    expect(workflow).not.toContain("AFK_GITHUB_APP_INSTALLATION_ID:");
    expect(workflow).not.toContain("secrets.AFK_DELIVERY_TOKEN");
    expect(workflow).not.toContain("secrets.MODEL_GATEWAY_TOKEN");
    expect(workflow).not.toContain("MODEL_GATEWAY_TOKEN:");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("GIT_CONFIG_VALUE_0: \"!gh auth git-credential\"");
  });

  it("keeps short-lived GitHub authority out of agent stage configuration", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    const implementation = workflow.slice(workflow.indexOf("name: Implement or continue Managed PR"));

    expect(implementation).toContain("GITHUB_TOKEN: ${{ steps.app-token.outputs.token }}");
    expect(implementation).not.toContain("AFK_GITHUB_APP_PRIVATE_KEY");
    expect(implementation).not.toContain("AFK_GITHUB_APP_INSTALLATION_ID");
    expect(implementation).not.toContain("GITHUB_TOKEN_FILE");
  });

  it("provides a credential-free GitHub-hosted PR quality gate", async () => {
    const workflow = await readFile(prWorkflowPath, "utf8");

    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("runs-on: ubuntu-latest");
    expect(workflow).toContain("npm ci");
    expect(workflow).toContain("npm run build");
    expect(workflow).toContain("npm run typecheck");
    expect(workflow).toContain("npm test");
    expect(workflow).not.toContain("self-hosted");
    expect(workflow).not.toMatch(/AFK_|MODEL_GATEWAY|secrets\./u);
  });

  it("smokes both stage images without host or GitHub authority", async () => {
    const smoke = await readFile(smokePath, "utf8");

    expect(smoke).toContain("AFK_DELIVERY_IMAGE");
    expect(smoke).toContain("AFK_REVIEWER_IMAGE");
    expect(smoke.match(/test ! -e \/var\/run\/docker\.sock/gu)).toHaveLength(2);
    expect(smoke.split('test -z "${GITHUB_TOKEN:-}${GH_TOKEN:-}"')).toHaveLength(3);
    expect(smoke).toContain("test ! -e \"$HOME/.claude.json\"");
    expect(smoke).toContain("IMPLEMENTATION_READ_ONLY_OK");
    expect(smoke).toContain("REVIEW_READ_ONLY_OK");
  });
});
