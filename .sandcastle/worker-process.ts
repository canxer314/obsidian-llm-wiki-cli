import type { WorkerProcessLaunchDisposition } from "./worker-process-lifecycle.ts";

export const INHERITED_JOB_PROCESS_GROUP = "SANDCASTLE_INHERITED_JOB_PROCESS_GROUP";

export function workerProcessEnvironment(
  disposition: WorkerProcessLaunchDisposition,
  inheritedEnvironment: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  const jobLogs = disposition.inherited
    ? Object.fromEntries([
        "SANDCASTLE_JOB_STDOUT_LOG",
        "SANDCASTLE_JOB_STDERR_LOG",
      ].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]))
    : {};
  return {
    HOME: process.env.HOME ?? "",
    PATH: process.env.PATH ?? "",
    ...(disposition.role === "owner" || disposition.inherited
      ? { [INHERITED_JOB_PROCESS_GROUP]: "1" }
      : {}),
    ...(disposition.role === "owner" ? inheritedEnvironment : jobLogs),
  };
}
