import { devNull } from "node:os";

import type { AgentStreamEvent, LoggingOption } from "@ai-hero/sandcastle";

import type { SandcastleLiveStatusPort } from "./live-status.js";

export function agentActivityLogging(
  sessionName: string,
  liveStatus: SandcastleLiveStatusPort | undefined,
): LoggingOption | undefined {
  if (liveStatus === undefined) return undefined;
  return {
    type: "file",
    path: devNull,
    onAgentStreamEvent: (event: AgentStreamEvent) => liveStatus.observeAgentEvent(event),
  };
}

export function agentActivityLoggingFields(
  sessionName: string,
  liveStatus: SandcastleLiveStatusPort | undefined,
): { readonly logging?: LoggingOption } {
  const logging = agentActivityLogging(sessionName, liveStatus);
  return logging === undefined ? {} : { logging };
}
