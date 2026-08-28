import { afterEach, describe, expect, it } from "vitest";

import {
  INHERITED_JOB_PROCESS_GROUP,
  workerProcessOptions,
} from "../.sandcastle/worker-process.js";

const original = process.env[INHERITED_JOB_PROCESS_GROUP];

afterEach(() => {
  if (original === undefined) delete process.env[INHERITED_JOB_PROCESS_GROUP];
  else process.env[INHERITED_JOB_PROCESS_GROUP] = original;
});

describe("worker process group policy", () => {
  it("creates the one outer process group and marks descendants as inherited", () => {
    delete process.env[INHERITED_JOB_PROCESS_GROUP];

    expect(workerProcessOptions("owner")).toMatchObject({
      detached: true,
      inherited: false,
      environment: { [INHERITED_JOB_PROCESS_GROUP]: "1" },
    });
  });

  it("keeps a standalone worker as its own bounded group", () => {
    delete process.env[INHERITED_JOB_PROCESS_GROUP];

    expect(workerProcessOptions("nested")).toMatchObject({
      detached: true,
      inherited: false,
    });
    expect(workerProcessOptions("nested").environment)
      .not.toHaveProperty(INHERITED_JOB_PROCESS_GROUP);
  });

  it("attaches every nested worker to an inherited whole-job group", () => {
    process.env[INHERITED_JOB_PROCESS_GROUP] = "1";

    expect(workerProcessOptions("nested")).toMatchObject({
      detached: false,
      inherited: true,
      environment: { [INHERITED_JOB_PROCESS_GROUP]: "1" },
    });
  });
});
