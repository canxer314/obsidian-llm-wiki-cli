import { cp, mkdtemp, rm, symlink, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveAutomationCommandRoute,
  resolveTargetOperationRoute,
} from "../.sandcastle/automation-command-route.js";

const executeFile = promisify(execFile);
const repositoryPath = resolve(import.meta.dirname, "..");
const routeModule = "automation-command-route.ts";
const roots: string[] = [];

const canonicalRoutes = [
  ["update-branch", "update-branch", "agent:update-branch", "pull-request", "pull-request"],
  ["implement", "implement-feedback", "agent:implement", "pull-request", "pull-request"],
  ["review", "review", "agent:review", "pull-request", "pull-request"],
  ["implement-issue", "implement-issue", "agent:implement", "issue", "issue"],
  ["implement-prd", "implement-prd", "agent:implement", "issue", "prd"],
  ["split-prd", "split-prd", "agent:to-issues", "issue", "prd"],
] as const;

const migrationSurfaces = [
  ["public Automation Command operation", "automation-command.ts"],
  ["GitHub discovery", "automation-github.ts"],
  ["Dispatcher command validation", "automation-dispatch.ts"],
  ["acquisition receiver and trigger selection", "automation-target-composition.ts"],
  ["direct CLI composition and scheduler identity", "target-operation-command.ts"],
  ["managed GitHub lifecycle trigger projection", "target-operation-github.ts"],
  ["Target operation dispatch", "target-operation-dispatch.ts"],
] as const;

async function isolatedSandcastle(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "automation-command-route-deletion-"));
  roots.push(root);
  const sandcastle = join(root, ".sandcastle");
  await cp(join(repositoryPath, ".sandcastle"), sandcastle, { recursive: true });
  await symlink(join(repositoryPath, "node_modules"), join(root, "node_modules"), "dir");
  await unlink(join(sandcastle, routeModule));
  return sandcastle;
}

async function load(modulePath: string): Promise<void> {
  try {
    await executeFile(process.execPath, [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(pathToFileURL(modulePath).href)});`,
    ]);
  } catch (error) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error
      ? error.stderr
      : undefined;
    throw new Error(typeof stderr === "string" ? stderr : String(error));
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Automation Command route policy deletion", () => {
  it.each(canonicalRoutes)(
    "owns the five-part route for %s independently of its declaration",
    (operation, targetOperation, trigger, receiver, identityNamespace) => {
      const number = 357;
      const expected = {
        operation,
        targetOperation,
        trigger,
        receiver,
        identity: `${identityNamespace}:${number}`,
        number,
      };

      expect(resolveAutomationCommandRoute(operation, number)).toEqual(expected);
      expect(resolveTargetOperationRoute(targetOperation, number)).toEqual(expected);
    },
  );

  it.each(migrationSurfaces)(
    "%s cannot load after the canonical route module is isolated",
    async (_surface, entrypoint) => {
      const sandcastle = await isolatedSandcastle();

      await expect(load(join(sandcastle, entrypoint))).rejects.toThrow(
        /ERR_MODULE_NOT_FOUND[\s\S]*automation-command-route\.ts/u,
      );
    },
  );
});
