import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const sandcastleDirectory = resolve(import.meta.dirname, "../.sandcastle");
const lifecycleName = "worker-process-lifecycle.ts";
const timeoutName = "job-timeout.ts";
const lifecycle = readFileSync(resolve(sandcastleDirectory, lifecycleName), "utf8");
const timeout = readFileSync(resolve(sandcastleDirectory, timeoutName), "utf8");
const protocolRunnerNames = new Set([
  "agent-process-runner.ts",
  "architecture-review-process-runner.ts",
  "branch-update-conflict-process-runner.ts",
  "branch-update-process-runner.ts",
  "feedback-process-runner.ts",
  "implementation-process-runner.ts",
  "spec-implementation-process-runner.ts",
  "spec-split-process-runner.ts",
  "review-process-runner.ts",
]);

const excludedProductionDirectories = new Set([
  "dispatcher-jobs",
  "jobs",
  "logs",
  "recovered",
  "worktrees",
]);

interface ProductionSource {
  readonly name: string;
  readonly path: string;
  readonly content: string;
  readonly syntax: ts.SourceFile;
}

function source(name: string): string {
  return readFileSync(resolve(sandcastleDirectory, name), "utf8");
}

function productionSources(directory = sandcastleDirectory): readonly ProductionSource[] {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry): readonly ProductionSource[] => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (directory === sandcastleDirectory && excludedProductionDirectories.has(entry.name)) {
          return [];
        }
        return productionSources(path);
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) return [];
      const content = readFileSync(path, "utf8");
      return [{
        name: relative(sandcastleDirectory, path).split(sep).join("/"),
        path,
        content,
        syntax: ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true),
      }];
    });
}

function importedModuleSpecifiers(source: ProductionSource): readonly string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier !== undefined
      && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = node.arguments[0];
      if (specifier !== undefined && ts.isStringLiteral(specifier)) specifiers.push(specifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source.syntax);
  return specifiers;
}

function sourcePathForSpecifier(source: ProductionSource, specifier: string): string {
  const target = resolve(dirname(source.path), specifier);
  if (extname(target) === ".js") return `${target.slice(0, -3)}.ts`;
  if (extname(target) === "") return `${target}.ts`;
  return target;
}

function importsTimeout(source: ProductionSource): boolean {
  return importedModuleSpecifiers(source).some((specifier) => specifier.startsWith(".")
    && sourcePathForSpecifier(source, specifier) === resolve(sandcastleDirectory, timeoutName));
}

function containsNode(source: ProductionSource, predicate: (node: ts.Node) => boolean): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (predicate(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source.syntax);
  return found;
}

function callsNamed(node: ts.Node, name: string): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name;
}

function callsFixedAgentWorker(node: ts.Node): boolean {
  if (!callsNamed(node, "runAgentWorker")) return false;
  const options = node.arguments[0];
  if (options === undefined || !ts.isObjectLiteralExpression(options)) return false;
  return options.properties.some((property) => ts.isPropertyAssignment(property)
    && ((ts.isIdentifier(property.name) && property.name.text === "workerFile")
      || (ts.isStringLiteral(property.name) && property.name.text === "workerFile"))
    && ts.isStringLiteral(property.initializer)
    && /^[a-z-]+-worker\.ts$/u.test(property.initializer.text));
}

function protocolRunnerSources(sources: readonly ProductionSource[]): readonly ProductionSource[] {
  return sources.filter((source) => protocolRunnerNames.has(basename(source.name)));
}

function lifecycleAdapterSources(sources: readonly ProductionSource[]): readonly ProductionSource[] {
  return sources.filter((source) => containsNode(source, (node) =>
    callsNamed(node, "createWorkerProcessLifecycle")));
}

const listenerNames = new Set([
  "on",
  "once",
  "addListener",
  "prependListener",
  "prependOnceListener",
]);
function accessedName(expression: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression;
    if (argument !== undefined && ts.isStringLiteral(argument)) return argument.text;
  }
  return undefined;
}

function installsOutputListener(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const event = node.arguments[0];
  const listenerName = accessedName(node.expression);
  return listenerName !== undefined
    && listenerNames.has(listenerName)
    && event !== undefined
    && ts.isStringLiteral(event)
    && event.text === "data";
}

function reconstructsLifecycle(source: ProductionSource): boolean {
  return /\brunJobWithTimeout\b/u.test(source.content)
    || /\blifecycle\??\s*:/u.test(source.content)
    || containsNode(source, installsOutputListener);
}

describe("worker process lifecycle ownership", () => {
  it("keeps timeout orchestration behind the lifecycle seam", () => {
    const sources = productionSources();
    const timeoutImports = sources.filter(importsTimeout).map(({ name }) => name);
    const protocolRunners = protocolRunnerSources(sources);
    const lifecycleAdapters = lifecycleAdapterSources(sources);

    expect(timeoutImports).toEqual([lifecycleName]);
    expect(lifecycle).toContain('from "./job-timeout.ts"');
    expect(timeout).toContain("runJobWithTimeout");
    expect(protocolRunners.map(({ name }) => name)).toEqual([
      "agent-process-runner.ts",
      "architecture-review-process-runner.ts",
      "branch-update-conflict-process-runner.ts",
      "branch-update-process-runner.ts",
      "feedback-process-runner.ts",
      "implementation-process-runner.ts",
      "review-process-runner.ts",
      "spec-implementation-process-runner.ts",
      "spec-split-process-runner.ts",
    ]);
    for (const { name, content } of protocolRunners) {
      expect(content).not.toMatch(/\b(?:kill|wait|groupExited|probeGroup|processGroupOwner|inherited)\s*:/u);
      if (basename(name) !== "agent-process-runner.ts") {
        expect(content).not.toMatch(/readonly\s+(?:timeoutMilliseconds|graceMilliseconds)\??\s*:/u);
      }
    }
    const protectedAdapters = [...new Map(
      [...protocolRunners, ...lifecycleAdapters].map((source) => [source.path, source]),
    ).values()];
    for (const source of protectedAdapters) {
      expect(reconstructsLifecycle(source)).toBe(false);
    }
  });

  it("recognizes normalized nested timeout imports and reconstructed output listeners", () => {
    const nestedPath = resolve(sandcastleDirectory, "nested/review-process-runner.ts");
    const content = [
      'import "./subdirectory/../../job-timeout.ts";',
      'stdout?.once?.("data", consume);',
      'stderr["prependOnceListener"]("data", consume);',
    ].join("\n");
    const nested: ProductionSource = {
      name: "nested/review-process-runner.ts",
      path: nestedPath,
      content,
      syntax: ts.createSourceFile(nestedPath, content, ts.ScriptTarget.Latest, true),
    };

    expect(protocolRunnerSources([nested])).toEqual([nested]);
    expect(lifecycleAdapterSources([nested])).toEqual([]);
    expect(importsTimeout(nested)).toBe(true);
    expect(reconstructsLifecycle(nested)).toBe(true);
  });

  it("keeps semantic disposition in the lifecycle and environment construction as a consumer", () => {
    const workerProcess = source("worker-process.ts");
    const dispositionOwners = productionSources()
      .filter(({ content }) => /INHERITED_JOB_PROCESS_GROUP\]\s*===\s*["']1["']/u.test(content))
      .map(({ name }) => name);

    expect(dispositionOwners).toEqual([lifecycleName]);
    expect(workerProcess).toContain("workerProcessEnvironment(");
    expect(workerProcess).not.toContain("workerProcessOptions(");
    expect(workerProcess).not.toMatch(/\b(?:detached|inherited)\s*:/u);
  });

  it("does not turn lifecycle admission into a command specification", () => {
    expect(lifecycle).not.toMatch(/\bspawn\b/u);
    expect(lifecycle).not.toMatch(
      /readonly\s+(?:executable|argv|arguments_|environment|checkoutPath|worker(?:File|Path)|command)\b/u,
    );
  });

  it("keeps fixed launch authority in the concrete protocol adapters", () => {
    expect(source("agent-process-runner.ts")).toContain("spawn(process.execPath");
    expect(source("review-process-runner.ts")).toContain('"review-worker.ts"');
    expect(source("architecture-review-process-runner.ts")).toContain('"architecture-review-worker.ts"');
    expect(source("branch-update-process-runner.ts")).toContain('spawn("git"');
    const fixedAgentWorkers = protocolRunnerSources(productionSources())
      .filter((source) => containsNode(source, callsFixedAgentWorker));
    expect(fixedAgentWorkers).toHaveLength(5);
    for (const { content } of fixedAgentWorkers) {
      expect(content).toMatch(/workerFile:\s*"[a-z-]+-worker\.ts"/u);
    }
  });
});
