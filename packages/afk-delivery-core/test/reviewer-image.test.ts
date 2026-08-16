import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const REVIEW_SKILL_SHA256 = "bab450f3b140af9327d945cf9bb12dc5c68bc0381f9afb1aea42083709fa5035";

async function repositoryPath(path: string): Promise<string> {
  return new URL(`../../../${path}`, import.meta.url).pathname;
}

async function repositoryFile(path: string): Promise<string> {
  return readFile(await repositoryPath(path), "utf8");
}

const COMPLETE_BUNDLE = {
  ticket: { number: 67, body: "Complete ticket" },
  repositoryInstructions: "Repository instructions",
  domainDocuments: [{ path: "docs/contexts/afk-delivery/CONTEXT.md", content: "Domain" }],
  architectureDecisions: [{ path: "docs/adr/0001.md", content: "ADR" }],
  baseRevision: "b".repeat(40),
  headRevision: "a".repeat(40),
  diff: "diff --git a/a.ts b/a.ts\n+change",
  round: 1,
  skill: {
    path: "/home/agent/.claude/skills/code-review/SKILL.md",
    revision: `sha256:${REVIEW_SKILL_SHA256}`,
  },
  capabilities: {
    sourceReadOnly: true,
    canEdit: false,
    canCommit: false,
    canPush: false,
    canComment: false,
    githubCredentials: false,
  },
};

describe("Sandcastle reviewer image", () => {
  it("contains the audited fixed-revision code-review skill", async () => {
    const skill = await repositoryFile(".sandcastle/skills/code-review/SKILL.md");
    const dockerfile = await repositoryFile(".sandcastle/reviewer.Dockerfile");

    expect(createHash("sha256").update(skill).digest("hex")).toBe(REVIEW_SKILL_SHA256);
    expect(dockerfile).toContain("COPY --chown=${AGENT_UID}:${AGENT_GID} .sandcastle/skills/code-review/SKILL.md /home/agent/.claude/skills/code-review/SKILL.md");
    expect(dockerfile).toContain(REVIEW_SKILL_SHA256);
    expect(dockerfile).not.toMatch(/\.claude\/skills.*(?:mount|volume)/iu);
  });

  it("omits GitHub mutation tooling and enforces reviewer restrictions", async () => {
    const skill = await repositoryFile(".sandcastle/skills/code-review/SKILL.md");
    const dockerfile = await repositoryFile(".sandcastle/reviewer.Dockerfile");
    const launcher = await repositoryFile(".sandcastle/run-reviewer.sh");

    expect(dockerfile).not.toMatch(/(?:apt-get install|npm install)[^\n]*\bgh\b/iu);
    expect(skill).toContain("Do not edit files, create commits, push, comment on GitHub, or attempt repairs.");
    expect(skill).toContain("approved | changes-required | unable-to-review");
    expect(skill).toContain("explicit base Revision and exact head Revision");
    expect(launcher).toContain('--volume "$bundle_file:/review/input.json:ro"');
    expect(launcher).not.toContain("/home/agent/workspace");
    expect(launcher).toContain("node --input-type=module");
    expect(launcher).toContain("/code-review Review only the complete immutable evidence bundle at /review/input.json");
    expect(launcher).toContain("--read-only");
    expect(launcher).toContain("--cap-drop=ALL");
    expect(launcher).toContain("--tools Read");
    expect(launcher).toContain("--permission-mode dontAsk");
    expect(launcher).toContain("--no-session-persistence");
    expect(launcher).toContain("'{\"mcpServers\":{}}'");
    expect(launcher).not.toMatch(/GITHUB_TOKEN|GH_TOKEN|SSH_AUTH_SOCK|docker\.sock/gu);
  });

  it("executes the launcher with only an immutable bundle and restricted reviewer capabilities", async () => {
    const directory = await mkdtemp(join(tmpdir(), "afk-reviewer-test-"));
    try {
      const bundlePath = join(directory, "bundle.json");
      const argumentsPath = join(directory, "docker-arguments.txt");
      const fakeBin = join(directory, "bin");
      const dockerPath = join(fakeBin, "docker");
      await execFileAsync("mkdir", ["-p", fakeBin]);
      await writeFile(bundlePath, JSON.stringify(COMPLETE_BUNDLE));
      await writeFile(dockerPath, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argumentsPath}"\n`);
      await chmod(dockerPath, 0o755);

      await execFileAsync(await repositoryPath(".sandcastle/run-reviewer.sh"), [bundlePath], {
        env: {
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          AFK_REVIEW_TIMEOUT_SECONDS: "5",
        },
      });
      const args = (await readFile(argumentsPath, "utf8")).split("\n");
      expect(args).toContain("--read-only");
      expect(args).toContain("--cap-drop=ALL");
      const mountedBundle = args.find((argument) => argument.endsWith(":/review/input.json:ro"));
      expect(mountedBundle).toBeDefined();
      expect(mountedBundle).not.toBe(`${bundlePath}:/review/input.json:ro`);
      expect(mountedBundle).not.toContain(directory);
      expect(args).toContain("--tools");
      expect(args).toContain("Read");
      expect(args).toContain("--permission-mode");
      expect(args).toContain("dontAsk");
      expect(args.join("\n")).not.toContain("GITHUB_TOKEN");
      expect(args.join("\n")).not.toContain("/home/agent/workspace");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails before launching when the immutable review bundle is incomplete", async () => {
    const directory = await mkdtemp(join(tmpdir(), "afk-reviewer-invalid-"));
    try {
      const bundlePath = join(directory, "bundle.json");
      await writeFile(bundlePath, JSON.stringify({ ...COMPLETE_BUNDLE, diff: "" }));
      await expect(execFileAsync(await repositoryPath(".sandcastle/run-reviewer.sh"), [bundlePath]))
        .rejects.toMatchObject({ code: 65 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
