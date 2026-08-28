export const INHERITED_JOB_PROCESS_GROUP = "SANDCASTLE_INHERITED_JOB_PROCESS_GROUP";

export function workerProcessOptions(role: "owner" | "nested"): {
  readonly detached: boolean;
  readonly environment: Readonly<Record<string, string>>;
  readonly inherited: boolean;
} {
  const inherited = role === "nested" && process.env[INHERITED_JOB_PROCESS_GROUP] === "1";
  return {
    detached: role === "owner" || !inherited,
    environment: {
      HOME: process.env.HOME ?? "",
      PATH: process.env.PATH ?? "",
      ...(role === "owner" || inherited ? { [INHERITED_JOB_PROCESS_GROUP]: "1" } : {}),
    },
    inherited,
  };
}
