import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const mainPath = resolve(import.meta.dirname, "../.sandcastle/main.ts");

function runCli(args: readonly string[]) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", mainPath, ...args],
    { encoding: "utf8" },
  );
}

describe("Sandcastle CLI process", () => {
  it("returns exit code 2 when the default mode omits --issue", () => {
    const result = runCli([]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Missing required --issue <number>");
  });

  it("returns exit code 2 when --issue conflicts with --watch", () => {
    const result = runCli(["--issue", "100", "--watch"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "--issue and --watch cannot be used together",
    );
  });
});
