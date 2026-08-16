import { describe, expect, it, vi } from "vitest";
import { runCommissioningPreflight } from "../src/commissioning-preflight.js";

describe("commissioning preflight", () => {
  it("passes one App credential directly to preflight without exposing or returning it", async () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    const credential = {
      token: "short-lived-token",
      actorLogin: "afk-delivery-canary[bot]",
      actorType: "Bot" as const,
    };
    const issueCredential = vi.fn(async () => credential);
    const preflight = vi.fn(async (received: typeof credential) => {
      expect(received).toEqual(credential);
      expect(process.env.GITHUB_TOKEN).toBeUndefined();
      expect(process.env.GH_TOKEN).toBeUndefined();
      return { status: "ready" as const, checks: ["github-authentication" as const] };
    });

    const result = await runCommissioningPreflight({
      expectedRepository: "canxer314/obsidian-llm-wiki-cli",
      issueCredential,
      preflight,
    });

    expect(issueCredential).toHaveBeenCalledWith("canxer314/obsidian-llm-wiki-cli");
    expect(preflight).toHaveBeenCalledOnce();
    expect(result).toEqual({ status: "ready", checks: ["github-authentication"] });
    expect(JSON.stringify(result)).not.toContain("short-lived-token");
    expect(process.env.GITHUB_TOKEN).toBeUndefined();
    expect(process.env.GH_TOKEN).toBeUndefined();
  });
});
