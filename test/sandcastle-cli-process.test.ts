import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const mainPath = resolve(import.meta.dirname, "../.sandcastle/main.ts");

function runCli(args: readonly string[], environment?: NodeJS.ProcessEnv) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", mainPath, ...args],
    { encoding: "utf8", env: environment ?? process.env },
  );
}

function fakeReadPorts(options: {
  readonly failWorktreeRead?: boolean;
  readonly inconsistentWorktree?: boolean;
} = {}) {
  const directory = mkdtempSync(resolve(tmpdir(), "sandcastle-inspector-"));
  const calls = resolve(directory, "calls");
  writeFileSync(calls, "");
  const command = `#!/bin/sh
printf '%s %s\\n' "$(basename "$0")" "$*" >> "$SANDCASTLE_TEST_CALLS"
case "$(basename "$0") $*" in
  "gh repo view"*) printf '%s\\n' 'owner/repository' ;;
  "gh api repos/{owner}/{repo}/commits/HEAD"*) printf '%s\\n' '${"a".repeat(40)}' ;;
  "gh api repos/owner/repository/issues/206"*) printf '%s\\n' '{"state":"open","labels":["Sandcastle"]}' ;;
  "gh api repos/owner/repository/git/ref/heads/sandcastle%2Fissue-206"*) ${options.inconsistentWorktree ? "printf '%s\\n' 'HTTP 404 not found' >&2; exit 1" : "exit 1"} ;;
  "gh api graphql"*) printf '%s\\n' '{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}' ;;
  "git worktree list --porcelain") ${options.failWorktreeRead ? "exit 1" : options.inconsistentWorktree ? `printf 'worktree ${directory}\\nbranch refs/heads/sandcastle/issue-206\\n'` : "exit 0"} ;;
  "git status --porcelain --untracked-files=normal") printf '%s\\n' 'dirty' ;;
  "docker container ls --all --filter label=com.sandcastle.repository=owner/repository"*) exit 0 ;;
  "docker container ls --all --filter name=^sandcastle-"*) exit 0 ;;
  *) exit 97 ;;
esac
`;
  for (const executable of ["gh", "git", "docker"]) {
    const path = resolve(directory, executable);
    writeFileSync(path, command);
    chmodSync(path, 0o755);
  }
  return {
    calls,
    environment: {
      ...process.env,
      PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
      SANDCASTLE_TEST_CALLS: calls,
    },
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
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

  it("renders one JSON diagnostic on stdout without live status or writes", () => {
    const fake = fakeReadPorts();
    try {
      const result = runCli(["--inspect-claim", "206", "--status-format", "json"], fake.environment);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const output = JSON.parse(result.stdout);
      expect(output.sandcastleClaimInspection).toMatchObject({
        version: 1,
        repository: "owner/repository",
        issueNumber: 206,
        branch: "sandcastle/issue-206",
        issue: { existence: "present", state: "open", eligibility: "eligible" },
        classification: "unknown",
        recommendedAction: "manual-review",
      });
      expect(result.stdout).not.toContain("sandcastleStatus");
      expect(result.stdout).not.toContain("sandcastleEvidence");
      const calls = readFileSync(fake.calls, "utf8").trim().split("\n");
      expect(calls).toHaveLength(8);
      expect(calls.every((call) => /^(?:gh (?:repo view|api)|git worktree list|docker container ls)\b/u.test(call)))
        .toBe(true);
    } finally {
      fake.dispose();
    }
  });

  it("renders the fixed human projection on stdout", () => {
    const fake = fakeReadPorts();
    try {
      const result = runCli(["--inspect-claim", "206", "--status-format", "human"], fake.environment);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("repository=owner/repository");
      expect(result.stdout).toContain("issue.number=206");
      expect(result.stdout).toContain("classification=unknown");
      expect(result.stdout).toContain("recommended-action=manual-review");
    } finally {
      fake.dispose();
    }
  });

  it.each(["0", "-1", "1.5", "9007199254740992"])(
    "rejects invalid inspect Issue number %s before reading ports",
    (value) => {
      const fake = fakeReadPorts();
      try {
        const result = runCli(["--inspect-claim", value], fake.environment);

        expect(result.status).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("--inspect-claim requires a positive integer");
        expect(readFileSync(fake.calls, "utf8")).toBe("");
      } finally {
        fake.dispose();
      }
    },
  );

  it("projects a port read failure as unknown with a manual-review action", () => {
    const fake = fakeReadPorts({ failWorktreeRead: true });
    try {
      const result = runCli(["--inspect-claim", "206", "--status-format", "human"], fake.environment);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("worktree=unknown");
      expect(result.stdout).toContain("recommended-action=manual-review");
      expect(result.stdout).not.toContain("worktree=absent");
    } finally {
      fake.dispose();
    }
  });

  it("projects inconsistent facts without suggesting deletion", () => {
    const fake = fakeReadPorts({ inconsistentWorktree: true });
    try {
      const result = runCli(["--inspect-claim", "206", "--status-format", "json"], fake.environment);

      expect(result.status).toBe(0);
      const inspection = JSON.parse(result.stdout).sandcastleClaimInspection;
      expect(inspection).toMatchObject({
        claimBranch: { state: "absent" },
        worktree: "dirty",
        inconsistent: true,
        classification: "inconsistent",
        recommendedAction: "manual-review",
      });
      expect(result.stdout).not.toMatch(/(?:cleanup|delete|remove)/u);
    } finally {
      fake.dispose();
    }
  });

  it.each([
    ["watch", ["--inspect-claim", "206", "--watch"]],
    ["duplicate", ["--inspect-claim", "206", "--inspect-claim", "207"]],
    ["live status", ["--inspect-claim", "206", "--no-live-status"]],
  ])("rejects inspect mode combined with %s at process level", (_name, argv) => {
    const fake = fakeReadPorts();
    try {
      const result = runCli(argv, fake.environment);

      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(readFileSync(fake.calls, "utf8")).toBe("");
    } finally {
      fake.dispose();
    }
  });

  it("rejects inspect mode combined with execution modes before reading ports", () => {
    const fake = fakeReadPorts();
    try {
      const result = runCli(["--inspect-claim", "206", "--issue", "206"], fake.environment);

      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("--inspect-claim, --issue, and --watch cannot be used together");
      expect(readFileSync(fake.calls, "utf8")).toBe("");
    } finally {
      fake.dispose();
    }
  });
});
