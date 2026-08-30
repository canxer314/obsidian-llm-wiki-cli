import { describe, expect, it } from "vitest";

import {
  INHERITED_JOB_PROCESS_GROUP,
  workerProcessEnvironment,
} from "../.sandcastle/worker-process.js";

describe("worker process environment", () => {
  it("marks an owner disposition for nested inheritance", () => {
    expect(workerProcessEnvironment({ role: "owner", detached: true, inherited: false }))
      .toMatchObject({ [INHERITED_JOB_PROCESS_GROUP]: "1" });
  });

  it("leaves a standalone nested disposition unmarked", () => {
    expect(workerProcessEnvironment({ role: "nested", detached: true, inherited: false }))
      .not.toHaveProperty(INHERITED_JOB_PROCESS_GROUP);
  });

  it("propagates inherited job logs for an inherited nested disposition", () => {
    const previousMarker = process.env[INHERITED_JOB_PROCESS_GROUP];
    const previousLog = process.env.SANDCASTLE_JOB_STDOUT_LOG;
    process.env[INHERITED_JOB_PROCESS_GROUP] = "not-a-trusted-marker";
    process.env.SANDCASTLE_JOB_STDOUT_LOG = "/jobs/stdout.log";
    try {
      expect(workerProcessEnvironment({ role: "nested", detached: false, inherited: true }))
        .toMatchObject({
          [INHERITED_JOB_PROCESS_GROUP]: "1",
          SANDCASTLE_JOB_STDOUT_LOG: "/jobs/stdout.log",
        });
    } finally {
      if (previousMarker === undefined) delete process.env[INHERITED_JOB_PROCESS_GROUP];
      else process.env[INHERITED_JOB_PROCESS_GROUP] = previousMarker;
      if (previousLog === undefined) delete process.env.SANDCASTLE_JOB_STDOUT_LOG;
      else process.env.SANDCASTLE_JOB_STDOUT_LOG = previousLog;
    }
  });

  it("uses trusted owner environment without deriving disposition from the marker", () => {
    const previous = process.env[INHERITED_JOB_PROCESS_GROUP];
    process.env[INHERITED_JOB_PROCESS_GROUP] = "1";
    try {
      expect(workerProcessEnvironment(
        { role: "owner", detached: true, inherited: false },
        { TRUSTED: "value" },
      )).toMatchObject({ TRUSTED: "value", [INHERITED_JOB_PROCESS_GROUP]: "1" });
    } finally {
      if (previous === undefined) delete process.env[INHERITED_JOB_PROCESS_GROUP];
      else process.env[INHERITED_JOB_PROCESS_GROUP] = previous;
    }
  });
});
