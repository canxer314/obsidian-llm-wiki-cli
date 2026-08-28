import { appendFileSync } from "node:fs";

import type { AgentStreamEvent, LoggingOption } from "@ai-hero/sandcastle";

import { JOB_STDOUT_LOG } from "./job-logs.ts";

export function agentLogging(
  artifactPath?: string,
): LoggingOption | undefined {
  const jobPath = process.env[JOB_STDOUT_LOG];
  const path = artifactPath ?? jobPath;
  if (path === undefined) return undefined;
  return {
    type: "file",
    path,
    verbose: true,
    ...(artifactPath === undefined || jobPath === undefined
      ? {}
      : {
          onAgentStreamEvent: (event: AgentStreamEvent) => {
            if (event.type === "raw") {
              appendFileSync(jobPath, `${event.line}\n`);
            }
          },
        }),
  };
}
