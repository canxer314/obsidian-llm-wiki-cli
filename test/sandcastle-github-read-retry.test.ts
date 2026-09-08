import { describe, expect, it, vi } from "vitest";

import {
  createGithubSafeReadRetryBoundary,
  DEFAULT_RATE_LIMIT_RETRY_DELAY_MILLISECONDS,
  MAX_GITHUB_ATTEMPTS,
  RETRY_DELAYS_MS,
} from "../.sandcastle/github-cli.js";

const noopWait = async () => {};

const transientError = () => new Error("network reset");

const rateLimited = (stderr: string): Error =>
  Object.assign(new Error("gh exited"), { stderr });

describe("Sandcastle GitHub safe-read retry boundary", () => {
  it.each([
    { name: "REST GET", arguments: ["api", "repos/{owner}/{repo}/pulls/1/files"] },
    { name: "GraphQL", arguments: ["api", "graphql", "-f", "query=query{viewer{login}}"] },
    { name: "pr view", arguments: ["pr", "view", "1", "--json", "headRefOid"] },
    { name: "repo view", arguments: ["repo", "view", "--json", "defaultBranchRef"] },
    { name: "issue list", arguments: ["issue", "list", "--state", "open", "--json", "number"] },
    { name: "label list", arguments: ["label", "list", "--limit", "100", "--json", "name"] },
  ])("retries a transiently failing $name read within the existing budget", async ({ arguments: arguments_ }) => {
    const execute = vi.fn()
      .mockRejectedValueOnce(transientError())
      .mockResolvedValueOnce({ stdout: "{}", stderr: "" });
    const waits: number[] = [];
    const read = createGithubSafeReadRetryBoundary(execute, async (milliseconds) => {
      waits.push(milliseconds);
    });

    await expect(read("gh", arguments_)).resolves.toEqual({ stdout: "{}", stderr: "" });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(1, "gh", arguments_, undefined);
    expect(execute).toHaveBeenNthCalledWith(2, "gh", arguments_, undefined);
    expect(waits).toEqual([RETRY_DELAYS_MS[0]]);
  });

  it("exhausts the shared transport budget and backoff before rethrowing", async () => {
    const execute = vi.fn().mockRejectedValue(transientError());
    const waits: number[] = [];
    const read = createGithubSafeReadRetryBoundary(execute, async (milliseconds) => {
      waits.push(milliseconds);
    });

    await expect(read("gh", ["pr", "view", "1", "--json", "headRefOid"])).rejects.toThrow("network reset");

    expect(execute).toHaveBeenCalledTimes(MAX_GITHUB_ATTEMPTS);
    expect(waits).toEqual([...RETRY_DELAYS_MS]);
  });

  it("honors a server rate-limit hint with one dedicated wait and no immediate retry", async () => {
    const execute = vi.fn()
      .mockRejectedValue(rateLimited("HTTP 429 Retry-After: 90 seconds"));
    const waits: number[] = [];
    const read = createGithubSafeReadRetryBoundary(execute, async (milliseconds) => {
      waits.push(milliseconds);
    });

    await expect(read("gh", ["pr", "view", "1", "--json", "headRefOid"])).rejects.toThrow("gh exited");

    expect(execute).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([90_000]);
  });

  it("defaults a rate-limit wait to the shared budget when the server gives no hint", async () => {
    const execute = vi.fn()
      .mockRejectedValue(rateLimited("HTTP 403: API rate limit exceeded"));
    const waits: number[] = [];
    const read = createGithubSafeReadRetryBoundary(execute, async (milliseconds) => {
      waits.push(milliseconds);
    });

    await expect(read("gh", ["repo", "view", "--json", "defaultBranchRef"])).rejects.toThrow("gh exited");

    expect(execute).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([DEFAULT_RATE_LIMIT_RETRY_DELAY_MILLISECONDS]);
  });

  it("performs exactly one dedicated rate-limit retry before giving up", async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce(rateLimited("HTTP 429 Too Many Requests"))
      .mockRejectedValueOnce(rateLimited("HTTP 429 Too Many Requests"))
      .mockResolvedValueOnce({ stdout: "{}", stderr: "" });
    const waits: number[] = [];
    const read = createGithubSafeReadRetryBoundary(execute, async (milliseconds) => {
      waits.push(milliseconds);
    });

    await expect(read("gh", ["api", "graphql", "-f", "query=query{viewer{login}}"])).rejects.toThrow("gh exited");

    expect(execute).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([DEFAULT_RATE_LIMIT_RETRY_DELAY_MILLISECONDS]);
  });

  it("does not retry a deterministic 4xx read", async () => {
    const notFound = rateLimited("HTTP 404 Not Found");
    const execute = vi.fn().mockRejectedValue(notFound);
    const waits: number[] = [];
    const read = createGithubSafeReadRetryBoundary(execute, async (milliseconds) => {
      waits.push(milliseconds);
    });

    await expect(read("gh", ["pr", "view", "404", "--json", "number"])).rejects.toBe(notFound);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it.each([
    {
      name: "POST",
      arguments: ["api", "--method", "POST", "repos/{owner}/{repo}/issues/1/labels", "-f", "labels[]=agent:implement"],
    },
    {
      name: "PATCH",
      arguments: ["api", "--method", "PATCH", "repos/{owner}/{repo}/issues/1", "-f", "state=closed"],
    },
    {
      name: "DELETE",
      arguments: ["api", "--method", "DELETE", "repos/{owner}/{repo}/issues/1/labels/agent%3Aimplement"],
    },
    {
      name: "mutating gh command",
      arguments: ["pr", "create", "--draft", "--head", "sandcastle/issue-1", "--body", "Closes #1"],
    },
    {
      name: "implicit POST inferred from -f body fields",
      arguments: ["api", "repos/{owner}/{repo}/issues/1/comments", "-f", "body=Implemented in abc. Part of #1."],
    },
    {
      name: "POST via the -X short method flag",
      arguments: ["api", "-X", "POST", "repos/{owner}/{repo}/issues/1/sub_issues", "-F", "sub_issue_id=3010"],
    },
    {
      name: "POST from an --input review body",
      arguments: ["api", "repos/{owner}/{repo}/pulls/1/reviews", "--method", "POST", "--input", "/tmp/review.json"],
    },
  ])("never retries $name writes", async ({ arguments: arguments_ }) => {
    const execute = vi.fn().mockRejectedValue(transientError());
    const waits: number[] = [];
    const read = createGithubSafeReadRetryBoundary(execute, async (milliseconds) => {
      waits.push(milliseconds);
    });

    await expect(read("gh", arguments_)).rejects.toThrow("network reset");

    expect(execute).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it("forwards extra execute arguments such as the child environment on every attempt", async () => {
    const environment = { GH_TOKEN: "test-token" };
    const execute = vi.fn()
      .mockRejectedValueOnce(transientError())
      .mockResolvedValueOnce({ stdout: "abc123\n", stderr: "" });
    const read = createGithubSafeReadRetryBoundary(execute, noopWait);

    await expect(read("gh", ["pr", "view", "1", "--json", "headRefOid", "--jq", ".headRefOid"], environment))
      .resolves.toEqual({ stdout: "abc123\n", stderr: "" });

    expect(execute).toHaveBeenNthCalledWith(1, "gh", ["pr", "view", "1", "--json", "headRefOid", "--jq", ".headRefOid"], environment);
    expect(execute).toHaveBeenNthCalledWith(2, "gh", ["pr", "view", "1", "--json", "headRefOid", "--jq", ".headRefOid"], environment);
  });
});
