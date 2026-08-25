import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const executeFile = promisify(execFile);
const roots: string[] = [];
const repositoryPath = resolve(import.meta.dirname, "..");

async function writeExecutable(path: string, source: string): Promise<void> {
  await writeFile(path, source, { mode: 0o700 });
  await chmod(path, 0o700);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Sandcastle inspect CLI", () => {
  it("reports missing GitHub authentication without probing or querying the remote command queue", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandcastle-inspect-cli-"));
    roots.push(root);
    const home = join(root, "home");
    const privateConfig = join(home, ".config", "sandcastle", "env");
    const settingsPath = join(home, ".claude", "settings.json");
    const bin = join(root, "bin");
    const callsPath = join(root, "calls.log");
    await Promise.all([
      mkdir(join(home, ".claude"), { recursive: true }),
      mkdir(join(home, ".config", "sandcastle"), { recursive: true }),
      mkdir(bin, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(settingsPath, JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://provider.invalid",
          ANTHROPIC_AUTH_TOKEN: "provider-token",
        },
      })),
      writeFile(privateConfig, "", { mode: 0o600 }),
    ]);
    await chmod(privateConfig, 0o600);
    await writeExecutable(join(bin, "docker"), `#!/bin/sh\nprintf 'docker %s\\n' "$*" >> "${callsPath}"\n[ "$1" = image ] && [ "$2" = inspect ] && exit 1\nexit 91\n`);
    await writeExecutable(join(bin, "gh"), `#!/bin/sh\nprintf 'gh %s\\n' "$*" >> "${callsPath}"\nexit 92\n`);
    await writeExecutable(join(bin, "git"), `#!/bin/sh\nprintf 'git %s\\n' "$*" >> "${callsPath}"\ncase "$*" in\n  *'user.name') printf 'Test Operator\\n' ;;\n  *'user.email') printf 'operator@example.invalid\\n' ;;\nesac\n`);

    const result = await executeFile("npm", ["run", "sandcastle", "--", "inspect"], {
      cwd: repositoryPath,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        GH_TOKEN: undefined,
      },
    });

    const output = result.stdout.trim().split("\n").at(-1);
    expect(JSON.parse(output ?? "")).toEqual({
      imageReadiness: "missing",
      githubAgentReadiness: "missing",
      commandInspection: "unavailable",
      activeJobs: [],
    });
    const calls = await readFile(callsPath, "utf8");
    expect(calls).toMatch(/^git -C .+ config --get user\.name\ngit -C .+ config --get user\.email\ndocker image inspect /u);
    expect(calls).not.toContain("docker run ");
    expect(calls).not.toContain("gh ");
  });
});
