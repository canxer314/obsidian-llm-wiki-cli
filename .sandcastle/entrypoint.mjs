import { mkdir, cp } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

const prompt = await new Promise((resolve, reject) => {
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  process.stdin.on("error", reject);
});

if (prompt.length === 0) throw new Error("implementation prompt is required on stdin");

const home = process.env.HOME ?? "/home/agent";
const skillsDirectory = join(home, ".claude", "skills");
await mkdir(skillsDirectory, { recursive: true });
for (const skill of ["implement", "tdd", "code-review"]) {
  await cp(`/opt/afk-delivery/skills/${skill}`, join(skillsDirectory, skill), { recursive: true });
}

if (process.env.MODEL_GATEWAY_URL !== undefined) {
  process.env.ANTHROPIC_BASE_URL = process.env.MODEL_GATEWAY_URL;
}
if (process.env.MODEL_GATEWAY_TOKEN !== undefined) {
  process.env.ANTHROPIC_AUTH_TOKEN = process.env.MODEL_GATEWAY_TOKEN;
}
delete process.env.MODEL_GATEWAY_URL;
delete process.env.MODEL_GATEWAY_TOKEN;
delete process.env.GITHUB_TOKEN;
delete process.env.GH_TOKEN;

const model = process.env.AFK_MODEL ?? "gpt-5.6-sol[1M]";
const requiredContextWindow = Number(process.env.AFK_CONTEXT_WINDOW ?? "372000");
if (!Number.isSafeInteger(requiredContextWindow) || requiredContextWindow <= 0) {
  throw new Error("AFK_CONTEXT_WINDOW must be a positive integer");
}
process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(requiredContextWindow);
process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(requiredContextWindow);
if (process.env.ANTHROPIC_BASE_URL !== undefined) {
  const modelsUrl = new URL("v1/models", process.env.ANTHROPIC_BASE_URL.endsWith("/")
    ? process.env.ANTHROPIC_BASE_URL
    : `${process.env.ANTHROPIC_BASE_URL}/`);
  const response = await fetch(modelsUrl, {
    headers: process.env.ANTHROPIC_AUTH_TOKEN === undefined
      ? {}
      : { authorization: `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}` },
  });
  if (!response.ok) throw new Error(`model gateway preflight returned ${response.status}`);
  const payload = await response.json();
  const candidates = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.models)
      ? payload.models
      : [];
  const selected = candidates.find((candidate) => candidate?.id === model);
  if (selected !== undefined && (!Number.isSafeInteger(selected.max_input_tokens) ||
      selected.max_input_tokens < requiredContextWindow)) {
    throw new Error(`model ${model} does not provide the required ${requiredContextWindow}-token context`);
  }
}

const child = spawn("claude", [
  "--print",
  "--model", model,
  "--max-turns", process.env.AFK_MAX_ITERATIONS ?? "24",
  "--permission-mode", "bypassPermissions",
  "--allowedTools", "Read,Edit,Write,Glob,Grep,Bash",
], {
  cwd: "/workspace",
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});
child.stdin.end(prompt);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
process.exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code) => resolve(code ?? 1));
});
