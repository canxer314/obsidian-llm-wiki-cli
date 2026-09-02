import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { runAutomationCli } from "../.sandcastle/automation-cli.js";

const executeFile = promisify(execFile);
const unitDirectory = resolve(import.meta.dirname, "..", ".sandcastle", "systemd");
const runbookPath = resolve(
  import.meta.dirname,
  "..",
  "docs",
  "operations",
  "sandcastle-local-dispatcher-runbook.md",
);

type UnitFile = Readonly<Record<string, Readonly<Record<string, string>>>>;

function parseUnit(source: string): UnitFile {
  const sections: Record<string, Record<string, string>> = {};
  let current: string | undefined;
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const section = /^\[(?<name>[A-Za-z]+)\]$/u.exec(trimmed);
    if (section?.groups !== undefined) {
      current = section.groups.name;
      sections[current] ??= {};
      continue;
    }
    const assignment = /^(?<key>[A-Za-z]+)=(?<value>.*)$/u.exec(trimmed);
    if (assignment?.groups === undefined || current === undefined) {
      throw new Error(`Unparseable systemd unit line: ${line}`);
    }
    sections[current][assignment.groups.key] = assignment.groups.value;
  }
  return sections;
}

async function readUnit(name: string): Promise<{ readonly source: string; readonly unit: UnitFile }> {
  const source = await readFile(resolve(unitDirectory, name), "utf8");
  return { source, unit: parseUnit(source) };
}

async function systemdAnalyzeAvailable(): Promise<boolean> {
  try {
    await executeFile("systemd-analyze", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

describe("systemd Dispatcher templates", () => {
  it("ships exactly the disabled oneshot service and timer templates for both write paths", async () => {
    const names = (await readdir(unitDirectory)).sort();
    expect(names).toEqual([
      "sandcastle-architecture-review.service",
      "sandcastle-architecture-review.timer",
      "sandcastle-dispatch.service",
      "sandcastle-dispatch.timer",
    ]);
    for (const base of ["sandcastle-dispatch", "sandcastle-architecture-review"]) {
      const service = await readUnit(`${base}.service`);
      const timer = await readUnit(`${base}.timer`);
      expect(service.unit.Service?.Type).toBe("oneshot");
      expect(timer.unit.Timer?.Unit).toBe(`${base}.service`);
      // Activation stays an explicit local operation: only the timers are
      // enable-able, and only into the user manager's timers.target.
      expect(timer.unit.Install?.WantedBy).toBe("timers.target");
      expect(service.unit.Install).toBeUndefined();
    }
  });

  it("resolves the trusted checkout, transport, and state locations without embedding credentials", async () => {
    for (const name of ["sandcastle-dispatch.service", "sandcastle-architecture-review.service"]) {
      const { source, unit } = await readUnit(name);
      expect(unit.Service?.WorkingDirectory).toBe("%h/repos/obsidian-llm-wiki-cli");
      // Node 24 type stripping runs the Dispatcher straight from trusted master.
      expect(unit.Service?.ExecStart).toMatch(/^%h\/\S*node --experimental-strip-types \.sandcastle\/main\.ts /u);
      // The Dispatcher enforces job time limits itself; the unit must not cut a round.
      expect(unit.Service?.TimeoutStartSec).toBe("0");
      expect(unit.Service?.Environment).toContain("PATH=");
      expect(unit.Service?.Environment).toContain("%h/.local/bin");
      // No credential may be assigned or referenced in a template: no
      // secret-named Environment assignment, and no EnvironmentFile directive
      // that could pull credentials from an uncontrolled location. Comments
      // may name the protected private environment file but never carry values.
      expect(source).not.toMatch(/^\s*Environment=.*(?:TOKEN|SECRET|KEY|PASSWORD)=\S+/mu);
      expect(source).not.toMatch(/^\s*EnvironmentFile=/mu);
    }
  });

  it("runs the accepted one-minute dispatch schedule through the real CLI wiring", async () => {
    const service = await readUnit("sandcastle-dispatch.service");
    const timer = await readUnit("sandcastle-dispatch.timer");
    expect(timer.unit.Timer?.OnCalendar).toBe("*-*-* *:*:15");
    const argv = service.unit.Service?.ExecStart?.split("main.ts ")[1]?.split(/\s+/u);
    expect(argv).toEqual(["dispatch"]);
    const dispatch = vi.fn().mockResolvedValue({ status: "dispatched", selected: [] });
    await expect(runAutomationCli(argv ?? [], {
      runReview: vi.fn(), runImplement: vi.fn(), runImplementPrd: vi.fn(),
      runFeedback: vi.fn(), runSplit: vi.fn(), runUpdate: vi.fn(), dispatch,
    })).resolves.toEqual({ status: "dispatched", selected: [] });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("schedules architecture review on the upstream weekday schedule without replaying missed runs", async () => {
    const service = await readUnit("sandcastle-architecture-review.service");
    const timer = await readUnit("sandcastle-architecture-review.timer");
    // Upstream agent architecture-review.yml: cron "0 9 * * 1-5" (09:00 UTC, Monday-Friday).
    expect(timer.unit.Timer?.OnCalendar).toBe("Mon..Fri *-*-* 09:00:00 UTC");
    expect(timer.unit.Timer?.Persistent).toBe("false");
    const argv = service.unit.Service?.ExecStart?.split("main.ts ")[1]?.split(/\s+/u);
    expect(argv).toEqual(["architecture-review"]);
    const architectureReview = vi.fn().mockResolvedValue({ status: "skipped" });
    await expect(runAutomationCli(argv ?? [], {
      runReview: vi.fn(), runImplement: vi.fn(), runImplementPrd: vi.fn(),
      runFeedback: vi.fn(), runSplit: vi.fn(), runUpdate: vi.fn(), architectureReview,
    })).resolves.toEqual({ status: "skipped" });
    expect(architectureReview).toHaveBeenCalledOnce();
  });

  it("documents image build and read-only verification before canaries and timer activation", async () => {
    const runbook = await readFile(runbookPath, "utf8");
    const build = runbook.indexOf("npm run sandcastle -- build-image");
    const verify = runbook.indexOf('"imageReadiness":"ready"');
    const canaries = runbook.indexOf('id="canary-sequence"');
    const enableDispatch = runbook.indexOf("systemctl --user enable --now sandcastle-dispatch.timer");
    const enableArchitecture = runbook.indexOf("systemctl --user enable --now sandcastle-architecture-review.timer");

    expect(build).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(build);
    expect(canaries).toBeGreaterThan(verify);
    expect(enableDispatch).toBeGreaterThan(canaries);
    expect(enableArchitecture).toBeGreaterThan(enableDispatch);
  });

  it("passes offline systemd unit verification without enabling or starting anything", async (context) => {
    if (!(await systemdAnalyzeAvailable())) {
      context.skip();
      return;
    }
    const names = await readdir(unitDirectory);
    await expect(executeFile("systemd-analyze", ["verify", "--user", ...names], { cwd: unitDirectory })).resolves.toBeDefined();
  });

  it("keeps both OnCalendar expressions valid systemd calendar syntax", async (context) => {
    if (!(await systemdAnalyzeAvailable())) {
      context.skip();
      return;
    }
    const dispatch = await readUnit("sandcastle-dispatch.timer");
    const review = await readUnit("sandcastle-architecture-review.timer");
    const dispatchCalendar = await executeFile("systemd-analyze", ["calendar", dispatch.unit.Timer?.OnCalendar ?? ""]);
    expect(dispatchCalendar.stdout).toContain("*-*-* *:*:15");
    const reviewCalendar = await executeFile("systemd-analyze", ["calendar", review.unit.Timer?.OnCalendar ?? ""]);
    expect(reviewCalendar.stdout).toContain("Mon..Fri *-*-* 09:00:00 UTC");
  });
});
