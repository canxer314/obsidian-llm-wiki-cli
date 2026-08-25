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

// The GitHub CLI authenticates through GH_TOKEN read from its environment;
// the token value never appears in command arguments.
const GITHUB_NAMES = ["GH_TOKEN"] as const;

// Container Agent git commits are authored on the operator's behalf. The
// container HOME has no .gitconfig and the checkout has no local identity, so
// the identity reaches git through these non-sensitive environment variables
// — the execution-proven extension of the GitHub-capable allowlist (#269).
const GIT_IDENTITY_NAMES = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

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
  readonly githubAgent: Readonly<Record<string, string>>;
} {
  const transport = pick(environment, TRANSPORT_NAMES);
  const processEnvironment = { ...transport, ...pick(environment, PROCESS_NAMES) };
  const claude = { ...transport, ...pick(environment, CLAUDE_NAMES) };
  return {
    dependencies: processEnvironment,
    git: processEnvironment,
    github: { ...transport, ...pick(environment, [...GITHUB_NAMES, "PATH"]) },
    claude,
    // GitHub-capable Agent Session container environment: the Claude/API
    // allowlist plus GH_TOKEN and the operator git identity on top of the
    // transport allowlist. No process variables — the Agent Session container
    // resolves PATH and HOME itself, and no Dispatcher model-routing or
    // private host configuration enters the container.
    githubAgent: { ...claude, ...pick(environment, [...GITHUB_NAMES, ...GIT_IDENTITY_NAMES]) },
  };
}
