import { describe, expect, it, vi } from "vitest";

import { AutomationCliError, runAutomationCli } from "../.sandcastle/automation-cli.js";

const usage = "Expected: run review <pull-request-number>, run feedback <pull-request-number>, run implement <issue-number>, run implement-prd <issue-number>, run split <issue-number>, run update-branch <pull-request-number>, or reconcile feedback <pull-request-number> [--base-revision <revision>] [--expected-post <revision>] [--reply-root <id>] [--reply-body <text>]";

describe("automation command CLI", () => {
  it("dispatches only fixed review, feedback, implement, implement-prd, split, and update-branch operations", async () => {
    const runReview = vi.fn().mockResolvedValue({ status: "reviewed" });
    const runFeedback = vi.fn().mockResolvedValue({ status: "implemented-feedback" });
    const runImplement = vi.fn().mockResolvedValue({ status: "implemented" });
    const runImplementPrd = vi.fn().mockResolvedValue({ status: "implemented-prd" });
    const runSplit = vi.fn().mockResolvedValue({ status: "split" });
    const runUpdate = vi.fn().mockResolvedValue({ status: "updated" });
    const dependencies = { runReview, runFeedback, runImplement, runImplementPrd, runSplit, runUpdate };

    await expect(runAutomationCli(["run", "review", "220"], dependencies)).resolves.toEqual({ status: "reviewed" });
    await expect(runAutomationCli(["run", "feedback", "221"], dependencies)).resolves.toEqual({ status: "implemented-feedback" });
    await expect(runAutomationCli(["run", "implement", "222"], dependencies)).resolves.toEqual({ status: "implemented" });
    await expect(runAutomationCli(["run", "implement-prd", "226"], dependencies)).resolves.toEqual({ status: "implemented-prd" });
    await expect(runAutomationCli(["run", "split", "223"], dependencies)).resolves.toEqual({ status: "split" });
    await expect(runAutomationCli(["run", "update-branch", "225"], dependencies)).resolves.toEqual({ status: "updated" });

    expect(runReview).toHaveBeenCalledWith(220);
    expect(runFeedback).toHaveBeenCalledWith(221);
    expect(runImplement).toHaveBeenCalledWith(222);
    expect(runImplementPrd).toHaveBeenCalledWith(226);
    expect(runSplit).toHaveBeenCalledWith(223);
    expect(runUpdate).toHaveBeenCalledWith(225);
  });

  it("passes the operation name to the preflight for every gated command", async () => {
    const preflight = vi.fn();
    const dependencies = {
      runReview: vi.fn(), runFeedback: vi.fn(), runImplement: vi.fn(), runImplementPrd: vi.fn(), runSplit: vi.fn(), runUpdate: vi.fn(),
      dispatch: vi.fn(), architectureReview: vi.fn(), preflight,
    };
    await runAutomationCli(["run", "review", "220"], dependencies);
    await runAutomationCli(["run", "feedback", "221"], dependencies);
    await runAutomationCli(["run", "implement", "222"], dependencies);
    await runAutomationCli(["run", "implement-prd", "226"], dependencies);
    await runAutomationCli(["run", "split", "223"], dependencies);
    await runAutomationCli(["run", "update-branch", "225"], dependencies);
    await runAutomationCli(["dispatch"], dependencies);
    await runAutomationCli(["architecture-review"], dependencies);
    expect(preflight.mock.calls).toEqual([
      ["review"],
      ["feedback"],
      ["implement"],
      ["implement-prd"],
      ["split"],
      ["update-branch"],
      ["dispatch"],
      ["architecture-review"],
    ]);
  });

  it("never runs the preflight for build-image, setup-labels, or inspect", async () => {
    const preflight = vi.fn();
    const dependencies = {
      runReview: vi.fn(), runFeedback: vi.fn(), runImplement: vi.fn(), runImplementPrd: vi.fn(), runSplit: vi.fn(), runUpdate: vi.fn(),
      buildImage: vi.fn(), setupLabels: vi.fn(), inspect: vi.fn(), preflight,
    };
    await runAutomationCli(["build-image"], dependencies);
    await runAutomationCli(["setup-labels"], dependencies);
    await runAutomationCli(["inspect"], dependencies);
    expect(preflight).not.toHaveBeenCalled();
  });

  it("routes a controlled reconcile authorization to the feedback operation", async () => {
    const runFeedback = vi.fn().mockResolvedValue({ status: "implemented-feedback" });
    const dependencies = {
      runReview: vi.fn(), runFeedback, runImplement: vi.fn(), runImplementPrd: vi.fn(), runSplit: vi.fn(), runUpdate: vi.fn(),
    };

    await expect(runAutomationCli(["reconcile", "feedback", "221", "--base-revision", "a".repeat(40)], dependencies))
      .resolves.toEqual({ status: "implemented-feedback" });
    expect(runFeedback).toHaveBeenCalledWith(221, { invocation: "reconcile", baseRevision: "a".repeat(40) });

    await expect(runAutomationCli(["reconcile", "feedback", "221", "--expected-post", "b".repeat(40), "--reply-root", "PRRC_x", "--reply-body", "Fixed."], dependencies))
      .resolves.toEqual({ status: "implemented-feedback" });
    expect(runFeedback).toHaveBeenCalledWith(221, {
      invocation: "reconcile",
      expectedPost: "b".repeat(40),
      expectedReply: { rootCommentId: "PRRC_x", body: "Fixed." },
    });
  });

  it("runs the feedback preflight for a reconcile authorization", async () => {
    const preflight = vi.fn();
    await runAutomationCli(["reconcile", "feedback", "221", "--base-revision", "a".repeat(40)], {
      runReview: vi.fn(), runFeedback: vi.fn(), runImplement: vi.fn(), runImplementPrd: vi.fn(), runSplit: vi.fn(), runUpdate: vi.fn(),
      preflight,
    });
    expect(preflight).toHaveBeenCalledWith("feedback");
  });

  it.each([
    [["reconcile", "implement", "221"], "Expected: reconcile feedback <pull-request-number> [--base-revision <revision>] [--expected-post <revision>] [--reply-root <id>] [--reply-body <text>]"],
    [["reconcile", "feedback", "0"], "reconcile feedback requires a positive Pull Request number"],
    [["reconcile", "feedback", "221", "--base-revision", "nope"], "--base-revision requires a 40-character revision"],
    [["reconcile", "feedback", "221", "--expected-post", "nope"], "--expected-post requires a 40-character revision"],
    [["reconcile", "feedback", "221", "--reply-root", "PRRC_x"], "--reply-root and --reply-body must be provided together"],
    [["reconcile", "feedback", "221", "--reply-body", "Fixed."], "--reply-root and --reply-body must be provided together"],
    [["reconcile", "feedback", "221", "--unknown", "x"], "Unknown reconcile flag: --unknown"],
    [["reconcile", "feedback", "221", "--base-revision"], "--base-revision requires a value"],
  ])("rejects malformed reconcile command shapes", async (argv, message) => {
    await expect(runAutomationCli(argv, {
      runReview: vi.fn(),
      runFeedback: vi.fn(),
      runImplement: vi.fn(),
      runImplementPrd: vi.fn(),
      runSplit: vi.fn(),
      runUpdate: vi.fn(),
    })).rejects.toEqual(new AutomationCliError(message));
  });

  it.each([
    [[], usage],
    [["run", "anything", "220"], "Unknown automation operation: anything"],
    [["run", "review", "0"], "review requires a positive Pull Request number"],
    [["run", "feedback", "0"], "feedback requires a positive Pull Request number"],
    [["run", "implement", "0"], "implement requires a positive Issue number"],
    [["run", "implement-prd", "0"], "implement-prd requires a positive Issue number"],
    [["run", "split", "0"], "split requires a positive Issue number"],
    [["run", "update-branch", "0"], "update-branch requires a positive Pull Request number"],
    [["run", "implement", "220", "--model", "anything"], usage],
    [["run", "implement-prd"], usage],
  ])("rejects arbitrary command shapes", async (argv, message) => {
    await expect(runAutomationCli(argv, {
      runReview: vi.fn(),
      runFeedback: vi.fn(),
      runImplement: vi.fn(),
      runImplementPrd: vi.fn(),
      runSplit: vi.fn(),
      runUpdate: vi.fn(),
    })).rejects.toEqual(new AutomationCliError(message));
  });
});
