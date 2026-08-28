import { appendFile, chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { agentLogging } from "../.sandcastle/agent-logging.js";
import {
  appendJobOutput,
  completeJobLog,
  createJobLog,
  removeExpiredJobLogs,
} from "../.sandcastle/job-logs.js";

const roots: string[] = [];

describe("local whole-job logs", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("mirrors raw Agent events from operation artifacts into the whole-job transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-logs-"));
    roots.push(root);
    const jobPath = join(root, "stdout.log");
    const artifactPath = join(root, "review.log");
    await appendFile(jobPath, "");
    vi.stubEnv("SANDCASTLE_JOB_STDOUT_LOG", jobPath);

    const logging = agentLogging(artifactPath);
    expect(logging).toMatchObject({ type: "file", path: artifactPath, verbose: true });
    if (logging?.type !== "file") throw new Error("Expected file logging");
    logging.onAgentStreamEvent?.({
      type: "text",
      message: "parsed text",
      iteration: 1,
      timestamp: new Date(0),
    });
    logging.onAgentStreamEvent?.({
      type: "raw",
      line: '{"type":"assistant","message":"complete transcript"}',
      iteration: 1,
      timestamp: new Date(0),
    });

    await expect(readFile(jobPath, "utf8")).resolves.toBe(
      '{"type":"assistant","message":"complete transcript"}\n',
    );
  });

  it("retains complete stdout, stderr, and small metadata with private permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "job-logs-"));
    roots.push(root);
    const log = await createJobLog({
      root,
      jobId: "job-219",
      operation: "implement-issue",
      number: 219,
      revision: "a".repeat(40),
      now: 1_000,
    });

    appendJobOutput(log, "stdout", "planner transcript\n");
    appendJobOutput(log, "stdout", "implementer transcript\n");
    appendJobOutput(log, "stderr", "local diagnostic\n");
    await completeJobLog(log, { status: "completed", now: 2_000 });

    await expect(readFile(log.stdoutPath, "utf8")).resolves.toBe(
      "planner transcript\nimplementer transcript\n",
    );
    await expect(readFile(log.stderrPath, "utf8")).resolves.toBe("local diagnostic\n");
    await expect(readFile(log.metadataPath, "utf8").then(JSON.parse)).resolves.toMatchObject({
      jobId: "job-219",
      operation: "implement-issue",
      number: 219,
      revision: "a".repeat(40),
      status: "completed",
      startedAt: 1_000,
      completedAt: 2_000,
    });
    for (const path of [log.directory, log.stdoutPath, log.stderrPath, log.metadataPath]) {
      const mode = (await stat(path)).mode & 0o777;
      expect(mode).toBe(path === log.directory ? 0o700 : 0o600);
    }
  });

  it("repairs an existing log root to private permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "job-log-root-mode-"));
    roots.push(root);
    await chmod(root, 0o755);

    await createJobLog({
      root,
      jobId: "private-job",
      operation: "review",
      number: 219,
      revision: "a".repeat(40),
    });

    expect((await stat(root)).mode & 0o777).toBe(0o700);
  });

  it("removes only job logs older than seven days", async () => {
    const root = await mkdtemp(join(tmpdir(), "job-log-retention-"));
    roots.push(root);
    const now = 10 * 24 * 60 * 60 * 1000;
    const expired = await createJobLog({
      root,
      jobId: "expired-job",
      operation: "review",
      number: 219,
      revision: "a".repeat(40),
      now: 1,
    });
    const recent = await createJobLog({
      root,
      jobId: "recent-job",
      operation: "review",
      number: 220,
      revision: "b".repeat(40),
      now,
    });
    await appendFile(join(root, "preserve.txt"), "not a job directory");
    await mkdir(join(root, "structural"));
    const old = new Date(now - 7 * 24 * 60 * 60 * 1000 - 1);
    await utimes(expired.directory, old, old);

    await removeExpiredJobLogs({ root, now, preserve: ["structural"] });

    expect((await readdir(root)).sort()).toEqual([
      "preserve.txt",
      "recent-job",
      "structural",
    ]);
    await expect(stat(recent.directory)).resolves.toBeDefined();
  });
});
