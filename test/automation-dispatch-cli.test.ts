import { describe, expect, it, vi } from "vitest";

import { AutomationCliError, runAutomationCli } from "../.sandcastle/automation-cli.js";
import { GithubAgentReadinessError } from "../.sandcastle/github-readiness.js";

describe("automation command CLI", () => {
  it("dispatches one Dispatch Session and reads inspection without allowing arbitrary operations", async () => {
    const dispatch = vi.fn().mockResolvedValue({ status: "dispatched" });
    const inspect = vi.fn().mockResolvedValue({ commands: [] });
    const setupLabels = vi.fn().mockResolvedValue({ status: "labels-ready" });
    await expect(runAutomationCli(["dispatch", "--concurrency", "3"], {
      runReview: vi.fn(), runImplement: vi.fn(), runFeedback: vi.fn(), runSplit: vi.fn(), dispatch, inspect, setupLabels,
    })).resolves.toEqual({ status: "dispatched" });
    await expect(runAutomationCli(["setup-labels"], {
      runReview: vi.fn(), runImplement: vi.fn(), runFeedback: vi.fn(), runSplit: vi.fn(), dispatch, inspect, setupLabels,
    })).resolves.toEqual({ status: "labels-ready" });
    await expect(runAutomationCli(["inspect"], {
      runReview: vi.fn(), runImplement: vi.fn(), runFeedback: vi.fn(), runSplit: vi.fn(), dispatch, inspect, setupLabels,
    })).resolves.toEqual({ commands: [] });
    expect(dispatch).toHaveBeenCalledWith(3);
    expect(inspect).toHaveBeenCalledOnce();
  });

  it("wires the fixed idempotent image build command through the real parser", async () => {
    const buildImage = vi.fn().mockResolvedValue({ status: "image-ready" });

    await expect(runAutomationCli(["build-image"], {
      runReview: vi.fn(), runImplement: vi.fn(), runFeedback: vi.fn(), runSplit: vi.fn(),
      buildImage,
    })).resolves.toEqual({ status: "image-ready" });

    expect(buildImage).toHaveBeenCalledOnce();
    await expect(runAutomationCli(["build-image", "private-image-name"], {
      runReview: vi.fn(), runImplement: vi.fn(), buildImage,
    })).rejects.toEqual(new AutomationCliError("Expected: build-image"));
  });

  it("fails image readiness before dispatch can acquire an Automation Command", async () => {
    const events: string[] = [];
    const preflight = vi.fn(async () => {
      events.push("preflight");
      throw new Error("Sandcastle Docker image is not ready; run `npm run sandcastle -- build-image`");
    });
    const dispatch = vi.fn(async () => {
      events.push("dispatch");
      return { status: "dispatched" as const };
    });

    await expect(runAutomationCli(["dispatch"], {
      runReview: vi.fn(), runImplement: vi.fn(), runFeedback: vi.fn(), runSplit: vi.fn(),
      preflight, dispatch,
    })).rejects.toThrow("Sandcastle Docker image is not ready");

    expect(events).toEqual(["preflight"]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["review", "259", "runReview"],
    ["implement", "259", "runImplement"],
    ["implement-spec", "259", "runImplementSpec"],
    ["feedback", "259", "runFeedback"],
    ["split", "259", "runSplit"],
  ] as const)("fails missing GitHub-capable Agent readiness before $operation acquires its Work Item", async (operation, number, target) => {
    const readinessError = new GithubAgentReadinessError("missing");
    const preflight = vi.fn().mockRejectedValue(readinessError);
    const dependencies = {
      runReview: vi.fn(),
      runImplement: vi.fn(),
      runImplementSpec: vi.fn(),
      runFeedback: vi.fn(),
      runSplit: vi.fn(),
      runUpdate: vi.fn(),
      preflight,
    };

    await expect(runAutomationCli(["run", operation, number], dependencies)).rejects.toBe(readinessError);

    expect(preflight).toHaveBeenCalledExactlyOnceWith(operation);
    expect(dependencies[target]).not.toHaveBeenCalled();
  });

  it("fails image readiness before an explicit operation can acquire its Work Item", async () => {
    const runImplement = vi.fn();
    const preflight = vi.fn().mockRejectedValue(
      new Error("Sandcastle Docker image is not ready; run `npm run sandcastle -- build-image`"),
    );

    await expect(runAutomationCli(["run", "implement", "259"], {
      runReview: vi.fn(), runImplement, runFeedback: vi.fn(), runSplit: vi.fn(), preflight,
    })).rejects.toThrow("Sandcastle Docker image is not ready");

    expect(preflight).toHaveBeenCalledOnce();
    expect(runImplement).not.toHaveBeenCalled();
  });

  it("keeps inspection read-only when image readiness is missing", async () => {
    const preflight = vi.fn().mockRejectedValue(new Error("image missing"));
    const inspect = vi.fn().mockResolvedValue({
      imageReadiness: "missing",
      commands: [],
      activeJobs: [],
    });

    await expect(runAutomationCli(["inspect"], {
      runReview: vi.fn(), runImplement: vi.fn(), runFeedback: vi.fn(), runSplit: vi.fn(),
      preflight, inspect,
    })).resolves.toEqual({ imageReadiness: "missing", commands: [], activeJobs: [] });

    expect(preflight).not.toHaveBeenCalled();
    expect(inspect).toHaveBeenCalledOnce();
  });

  it("runs the fixed trusted architecture-review command without a Work Item number", async () => {
    const architectureReview = vi.fn().mockResolvedValue({ status: "skipped" });
    await expect(runAutomationCli(["architecture-review"], {
      runReview: vi.fn(), runImplement: vi.fn(), runFeedback: vi.fn(), runSplit: vi.fn(), architectureReview,
    })).resolves.toEqual({ status: "skipped" });
    expect(architectureReview).toHaveBeenCalledOnce();
  });

  it.each([[["architecture-review", "7"]], [["architecture-review", "--force"]]])(
    "rejects architecture-review requests with arbitrary arguments", async (argv) => {
      await expect(runAutomationCli(argv, {
        runReview: vi.fn(), runImplement: vi.fn(), architectureReview: vi.fn(),
      })).rejects.toEqual(new AutomationCliError("Expected: architecture-review"));
    },
  );

  it.each([["dispatch", "--concurrency", "0"], ["dispatch", "--other"], ["inspect", "--concurrency", "2"]])(
    "rejects unsafe dispatcher CLI options", async (argv) => {
      await expect(runAutomationCli(argv, { runReview: vi.fn(), runImplement: vi.fn(), dispatch: vi.fn(), inspect: vi.fn() }))
        .rejects.toBeInstanceOf(AutomationCliError);
    },
  );
});
