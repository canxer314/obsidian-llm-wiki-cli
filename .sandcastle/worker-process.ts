export const INHERITED_JOB_PROCESS_GROUP = "SANDCASTLE_INHERITED_JOB_PROCESS_GROUP";

export function workerProcessOptions(
  role: "owner" | "nested",
  inheritedEnvironment: Readonly<Record<string, string>> = {},
): {
  readonly detached: boolean;
  readonly environment: Readonly<Record<string, string>>;
  readonly inherited: boolean;
} {
  const inherited = role === "nested" && process.env[INHERITED_JOB_PROCESS_GROUP] === "1";
  const jobLogs = inherited
    ? Object.fromEntries([
        "SANDCASTLE_JOB_STDOUT_LOG",
        "SANDCASTLE_JOB_STDERR_LOG",
      ].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]))
    : {};
  return {
    detached: role === "owner" || !inherited,
    environment: {
      HOME: process.env.HOME ?? "",
      PATH: process.env.PATH ?? "",
      ...(role === "owner" || inherited ? { [INHERITED_JOB_PROCESS_GROUP]: "1" } : {}),
      ...(role === "owner" ? inheritedEnvironment : jobLogs),
    },
    inherited,
  };
}
