import { describe, expect, it } from "vitest";
import {
  discoverDeliveryFrontier,
  type GitHubReadPort,
} from "../src/index.js";

function response(status: number, body: unknown, link?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: link === undefined ? undefined : { link },
  });
}

describe("discoverDeliveryFrontier", () => {
  it("paginates ready Delivery Tickets and excludes open native blockers without changing readiness", async () => {
    const requests: string[] = [];
    const github: GitHubReadPort = {
      async request(path) {
        requests.push(path);
        if (path === "/repos/acme/wiki/issues?state=open&labels=ready-for-agent&per_page=100&page=1") {
          return response(200, [{ number: 10, state: "open", labels: [{ name: "ready-for-agent" }], issue_dependencies_summary: { blocked_by: 0 } }],
            '<https://api.github.test/repos/acme/wiki/issues?state=open&labels=ready-for-agent&per_page=100&page=2>; rel="next"');
        }
        if (path === "/repos/acme/wiki/issues?state=open&labels=ready-for-agent&per_page=100&page=2") {
          return response(200, [
            { number: 11, state: "open", labels: [{ name: "ready-for-agent" }], issue_dependencies_summary: { blocked_by: 1 } },
            { number: 12, state: "open", labels: [{ name: "ready-for-agent" }, { name: "afk:prohibited" }], issue_dependencies_summary: { blocked_by: 0 } },
          ]);
        }
        if (path.endsWith("/issues/10/dependencies/blocked_by?per_page=100&page=1")) {
          return response(200, [{ number: 2, state: "closed" }]);
        }
        if (path.endsWith("/issues/11/dependencies/blocked_by?per_page=100&page=1")) {
          return response(200, [{ number: 3, state: "open" }]);
        }
        throw new Error(`unexpected request: ${path}`);
      },
    };

    const result = await discoverDeliveryFrontier(github, {
      owner: "acme",
      repository: "wiki",
      readyLabel: "ready-for-agent",
      prohibitedLabel: "afk:prohibited",
    });

    expect(result).toEqual({
      frontier: [{
        number: 10,
        open: true,
        labels: ["ready-for-agent"],
        openBlockerNumbers: [],
        dependencyDataComplete: true,
      }],
      excluded: [
        { ticketNumber: 11, reason: "open-blockers", openBlockerNumbers: [3] },
        { ticketNumber: 12, reason: "prohibited" },
      ],
    });
    expect(requests).toHaveLength(4);
    expect(requests.every((path) => !path.includes("PATCH") && !path.includes("labels/"))).toBe(true);
  });

  it.each([
    ["permission failure", response(403, { message: "Resource not accessible by integration" })],
    ["unexpected response shape", response(200, { dependencies: [] })],
    ["missing blocker state", response(200, [{ number: 4 }])],
  ])("fails closed on %s", async (_name, dependencyResponse) => {
    const github: GitHubReadPort = {
      async request(path) {
        return path.includes("blocked_by")
          ? dependencyResponse
          : response(200, [{ number: 10, state: "open", labels: [{ name: "ready-for-agent" }], issue_dependencies_summary: { blocked_by: 0 } }]);
      },
    };

    await expect(discoverDeliveryFrontier(github, {
      owner: "acme",
      repository: "wiki",
      readyLabel: "ready-for-agent",
      prohibitedLabel: "afk:prohibited",
    })).resolves.toEqual({
      frontier: [],
      excluded: [{ ticketNumber: 10, reason: "dependency-data-incomplete" }],
    });
  });

  it("fails closed when native dependency summary contradicts the paginated relationship", async () => {
    const github: GitHubReadPort = {
      async request(path) {
        return path.includes("blocked_by")
          ? response(200, [])
          : response(200, [{
              number: 10,
              state: "open",
              labels: [{ name: "ready-for-agent" }],
              issue_dependencies_summary: { blocked_by: 1 },
            }]);
      },
    };

    await expect(discoverDeliveryFrontier(github, {
      owner: "acme",
      repository: "wiki",
      readyLabel: "ready-for-agent",
      prohibitedLabel: "afk:prohibited",
    })).resolves.toEqual({
      frontier: [],
      excluded: [{ ticketNumber: 10, reason: "dependency-data-incomplete" }],
    });
  });

  it("excludes pull requests returned by the Issues API", async () => {
    const github: GitHubReadPort = {
      async request() {
        return response(200, [{
          number: 20,
          state: "open",
          labels: [{ name: "ready-for-agent" }],
          issue_dependencies_summary: { blocked_by: 0 },
          pull_request: { url: "https://api.github.test/repos/acme/wiki/pulls/20" },
        }]);
      },
    };

    await expect(discoverDeliveryFrontier(github, {
      owner: "acme",
      repository: "wiki",
      readyLabel: "ready-for-agent",
      prohibitedLabel: "afk:prohibited",
    })).resolves.toEqual({ frontier: [], excluded: [] });
  });
});
