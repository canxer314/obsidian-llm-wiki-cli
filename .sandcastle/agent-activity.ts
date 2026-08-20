import type { SandcastleObservedActivity } from "./live-status.js";

const INSPECTION_TOOLS = new Set([
  "Glob", "Grep", "LS", "Read", "WebFetch", "WebSearch", "mcp__codegraph__codegraph_explore",
]);
const EDITING_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit", "Write"]);
const COMMAND_TOOLS = new Set(["Bash"]);

export function classifyAgentStreamEvent(event: unknown): SandcastleObservedActivity | null {
  if (typeof event !== "object" || event === null || !("type" in event)) return "waiting";
  const type = event.type;
  if (type === "text" || type === "raw") return null;
  if (type !== "toolCall") return "waiting";
  if (!("name" in event) || typeof event.name !== "string") return "executing-other-tool";
  if (INSPECTION_TOOLS.has(event.name)) return "inspecting-repository";
  if (EDITING_TOOLS.has(event.name)) return "editing";
  if (COMMAND_TOOLS.has(event.name)) return "executing-command";
  return "executing-other-tool";
}
