import { lstat, readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

const CLAUDE_ENVIRONMENT_WHITELIST = new Set([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "DISABLE_PROMPT_CACHING_OPUS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

const PRIVATE_ENVIRONMENT_WHITELIST = new Set([
  ...CLAUDE_ENVIRONMENT_WHITELIST,
  "GH_TOKEN",
  "SANDCASTLE_MODEL",
  "SANDCASTLE_PLANNER_MODEL",
  "SANDCASTLE_IMPLEMENTER_MODEL",
  "SANDCASTLE_REVIEWER_MODEL",
]);

export interface SandcastleModels {
  readonly default: string;
  readonly planner: string;
  readonly implementer: string;
  readonly reviewer: string;
}

export interface SandcastlePrivateConfig {
  readonly environment: Readonly<Record<string, string>>;
  readonly models: SandcastleModels;
}

export interface SandcastleConfigPaths {
  readonly settingsPath: string;
  readonly envPath: string;
  readonly log?: (message: string) => void;
}

export class SandcastleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandcastleConfigError";
  }
}

function stringsFrom(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function whitelisted(
  values: Readonly<Record<string, string>>,
  whitelist: ReadonlySet<string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(
      ([name, value]) => whitelist.has(name) && value.length > 0,
    ),
  );
}

async function readClaudeEnvironment(settingsPath: string): Promise<Record<string, string>> {
  let source: string;
  try {
    source = await readFile(settingsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new SandcastleConfigError("Could not read Claude Code user settings");
  }

  try {
    const settings = JSON.parse(source) as { readonly env?: unknown };
    return whitelisted(stringsFrom(settings.env), CLAUDE_ENVIRONMENT_WHITELIST);
  } catch {
    throw new SandcastleConfigError("Claude Code user settings are not valid JSON");
  }
}

async function readPrivateEnvironment(envPath: string): Promise<Record<string, string>> {
  let metadata;
  try {
    metadata = await lstat(envPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SandcastleConfigError("Sandcastle private env file is missing");
    }
    throw new SandcastleConfigError("Could not inspect Sandcastle private env file");
  }

  if (!metadata.isFile()) {
    throw new SandcastleConfigError("Sandcastle private env path must be a regular file");
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new SandcastleConfigError("Sandcastle private env file must have mode 0600");
  }

  try {
    return whitelisted(
      stringsFrom(parseEnv(await readFile(envPath, "utf8"))),
      PRIVATE_ENVIRONMENT_WHITELIST,
    );
  } catch (error) {
    if (error instanceof SandcastleConfigError) throw error;
    throw new SandcastleConfigError("Sandcastle private env file is invalid");
  }
}

function requireConfiguration(environment: Readonly<Record<string, string>>): void {
  const missing: string[] = [];
  if (environment.ANTHROPIC_BASE_URL === undefined) missing.push("ANTHROPIC_BASE_URL");
  if (
    environment.ANTHROPIC_AUTH_TOKEN === undefined &&
    environment.ANTHROPIC_API_KEY === undefined
  ) {
    missing.push("ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY");
  }
  if (environment.GH_TOKEN === undefined) missing.push("GH_TOKEN");
  if (missing.length > 0) {
    throw new SandcastleConfigError(
      `Missing required Sandcastle configuration: ${missing.join(", ")}`,
    );
  }
}

function resolveModels(environment: Readonly<Record<string, string>>): SandcastleModels {
  const defaultModel = environment.SANDCASTLE_MODEL ?? "opus";
  return {
    default: defaultModel,
    planner: environment.SANDCASTLE_PLANNER_MODEL ?? defaultModel,
    implementer: environment.SANDCASTLE_IMPLEMENTER_MODEL ?? defaultModel,
    reviewer: environment.SANDCASTLE_REVIEWER_MODEL ?? defaultModel,
  };
}

export async function loadSandcastleConfig(
  paths: SandcastleConfigPaths,
): Promise<SandcastlePrivateConfig> {
  const [claudeEnvironment, privateEnvironment] = await Promise.all([
    readClaudeEnvironment(paths.settingsPath),
    readPrivateEnvironment(paths.envPath),
  ]);
  const merged = { ...claudeEnvironment, ...privateEnvironment };
  requireConfiguration(merged);
  const models = resolveModels(merged);
  const environment = Object.fromEntries(
    Object.entries(merged).filter(([name]) => !name.startsWith("SANDCASTLE_")),
  );

  const roleOverrideCount = [
    "SANDCASTLE_PLANNER_MODEL",
    "SANDCASTLE_IMPLEMENTER_MODEL",
    "SANDCASTLE_REVIEWER_MODEL",
  ].filter((name) => merged[name] !== undefined).length;
  paths.log?.(
    `Loaded Sandcastle private configuration (${Object.keys(environment).length} environment variables; ${roleOverrideCount} role model overrides)`,
  );
  return { environment, models };
}
