import { describe, expect, it, vi } from "vitest";

import {
  runLocalQuality,
  type LocalQualityHost,
} from "../.sandcastle/local-quality.js";

const revision = "0123456789abcdef0123456789abcdef01234567";

function host(overrides: Partial<LocalQualityHost> = {}): LocalQualityHost {
  return {
    setup: vi.fn(async () => undefined),
    run: vi.fn(async () => ({ exitCode: 0 })),
    dispose: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("Sandcastle local quality", () => {
  it("checks one exact revision in deterministic command order", async () => {
    const qualityHost = host();

    await expect(runLocalQuality(revision, qualityHost)).resolves.toEqual({
      status: "success",
    });
    expect(qualityHost.setup).toHaveBeenCalledWith(revision);
    expect(qualityHost.run).toHaveBeenCalledTimes(4);
    expect(vi.mocked(qualityHost.run).mock.calls).toEqual([
      [["npm", "ci"]],
      [["npm", "run", "build"]],
      [["npm", "run", "typecheck"]],
      [["npm", "test"]],
    ]);
    expect(qualityHost.dispose).toHaveBeenCalledOnce();
  });

  it("maps cleanup infrastructure failures to error", async () => {
    const qualityHost = host({
      dispose: vi.fn(async () => {
        throw new Error("could not remove container");
      }),
    });

    await expect(runLocalQuality(revision, qualityHost)).resolves.toEqual({
      status: "error",
      stage: "setup",
      output: "could not remove container",
    });
  });

  it("rejects mutable or abbreviated revisions before setup", async () => {
    const qualityHost = host();

    await expect(runLocalQuality("main", qualityHost)).resolves.toEqual({
      status: "error",
      stage: "setup",
      output: "Local quality requires a full 40-character commit SHA",
    });
    expect(qualityHost.setup).not.toHaveBeenCalled();
    expect(qualityHost.run).not.toHaveBeenCalled();
    expect(qualityHost.dispose).not.toHaveBeenCalled();
  });

  it("maps a quality-command infrastructure exception to error", async () => {
    const run = vi.fn(async (_command: readonly string[]) => ({ exitCode: 0 }));
    run.mockResolvedValueOnce({ exitCode: 0 });
    run.mockRejectedValueOnce(new Error("Docker daemon disconnected"));
    const qualityHost = host({ run });

    await expect(runLocalQuality(revision, qualityHost)).resolves.toEqual({
      status: "error",
      stage: "build",
      output: "Docker daemon disconnected",
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(qualityHost.dispose).toHaveBeenCalledOnce();
  });

  it("retries setup once after an infrastructure exception", async () => {
    const setup = vi.fn(async () => undefined);
    setup.mockRejectedValueOnce(new Error("Docker unavailable"));
    const qualityHost = host({ setup });

    await expect(runLocalQuality(revision, qualityHost)).resolves.toEqual({
      status: "success",
    });
    expect(setup).toHaveBeenCalledTimes(2);
    expect(setup).toHaveBeenNthCalledWith(1, revision);
    expect(setup).toHaveBeenNthCalledWith(2, revision);
    expect(qualityHost.dispose).toHaveBeenCalledTimes(2);
  });

  it("returns error after the second setup failure", async () => {
    const setup = vi.fn(async () => {
      throw new Error("checkout failed");
    });
    const qualityHost = host({ setup });

    await expect(runLocalQuality(revision, qualityHost)).resolves.toEqual({
      status: "error",
      stage: "setup",
      output: "checkout failed",
    });
    expect(setup).toHaveBeenCalledTimes(2);
    expect(qualityHost.run).not.toHaveBeenCalled();
    expect(qualityHost.dispose).toHaveBeenCalledTimes(2);
  });

  it("retries a failed install once but never retries quality commands", async () => {
    const run = vi.fn(async (_command: readonly string[]) => ({ exitCode: 0 }));
    run.mockResolvedValueOnce({ exitCode: 1, output: "network failed" });
    const qualityHost = host({ run });

    await expect(runLocalQuality(revision, qualityHost)).resolves.toEqual({
      status: "success",
    });
    expect(qualityHost.setup).toHaveBeenCalledTimes(2);
    expect(qualityHost.dispose).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.filter(([command]) => command.join(" ") === "npm ci")).toHaveLength(2);
  });

  it.each([
    ["build", 1],
    ["typecheck", 2],
    ["test", 3],
  ] as const)("stops after a %s failure without retrying it", async (stage, commandIndex) => {
    const run = vi.fn(async (_command: readonly string[]) => ({ exitCode: 0 }));
    run.mockImplementationOnce(async () => ({ exitCode: 0 }));
    for (let index = 1; index < commandIndex; index += 1) {
      run.mockImplementationOnce(async () => ({ exitCode: 0 }));
    }
    run.mockImplementationOnce(async () => ({ exitCode: 1, output: `${stage} failed` }));
    const qualityHost = host({ run });

    await expect(runLocalQuality(revision, qualityHost)).resolves.toEqual({
      status: "failure",
      stage,
      output: `${stage} failed`,
    });
    expect(run).toHaveBeenCalledTimes(commandIndex + 1);
  });
});
