import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const fixture = resolve(import.meta.dirname, "fixtures/sandcastle-signal-child.ts");

async function runWithSignal(signal: "SIGINT" | "SIGTERM") {
  const child = spawn(process.execPath, ["--experimental-strip-types", fixture, signal], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let sent = false;
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (!sent && stdout.includes(`ready:${signal}`)) {
      sent = true;
      child.kill(signal);
    }
  });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => child.on("exit", (code, exitSignal) => resolveExit({ code, signal: exitSignal })),
  );
  return { ...result, stdout, stderr };
}

describe("Sandcastle process signal wiring", () => {
  it.each(["SIGINT", "SIGTERM"] as const)(
    "handles real %s through controlled teardown",
    async (signal) => {
      const result = await runWithSignal(signal);

      expect(result, JSON.stringify(result)).toMatchObject({ code: 1, signal: null });
      expect(result.stdout).toBe(`ready:${signal}\nteardown-complete\n`);
      expect(result.stderr).toBe("AbortError\n");
      expect(`${result.stdout}${result.stderr}`).not.toContain("Sandcastle forced exit requested");
    },
  );
});
