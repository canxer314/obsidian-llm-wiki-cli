const TRANSPORT_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
] as const;

const CLAUDE_NAMES = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
] as const;

// git and npm are resolved through PATH and read configuration and caches
// from HOME, so those two entries join the transport variables in the
// environments that spawn them.
const PROCESS_NAMES = ["PATH", "HOME"] as const;

function pick(
  environment: Readonly<Record<string, string>>,
  names: readonly string[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(names.flatMap((name) => {
    const value = environment[name];
    return value === undefined ? [] : [[name, value]];
  }));
}

export function createChildEnvironments(environment: Readonly<Record<string, string>>): {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly git: Readonly<Record<string, string>>;
  readonly github: Readonly<Record<string, string>>;
  readonly claude: Readonly<Record<string, string>>;
} {
  const transport = pick(environment, TRANSPORT_NAMES);
  const processEnvironment = { ...transport, ...pick(environment, PROCESS_NAMES) };
  return {
    dependencies: processEnvironment,
    git: processEnvironment,
    github: { ...transport, ...pick(environment, ["GH_TOKEN", "PATH"]) },
    claude: { ...transport, ...pick(environment, CLAUDE_NAMES) },
  };
}
