import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

// Failed or timed-out Target Checkouts stay on disk for diagnosis and follow
// the same seven-day retention policy as review artifacts.
const FAILURE_CHECKOUT_RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

export async function removeExpiredFailureCheckouts(options: {
  readonly root: string;
  readonly preserve?: readonly string[];
  readonly now?: number;
}): Promise<void> {
  const preserve = new Set(options.preserve ?? []);
  let entries;
  try {
    entries = await readdir(options.root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const expiredBefore = (options.now ?? Date.now()) - FAILURE_CHECKOUT_RETENTION_MILLISECONDS;
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && !preserve.has(entry.name))
    .map(async (entry) => {
      const path = join(options.root, entry.name);
      if ((await stat(path)).mtimeMs < expiredBefore) {
        await rm(path, { recursive: true, force: true });
      }
    }));
}

export interface TargetCheckout {
  withCheckout<TResult>(
    request: { readonly pullRequestNumber?: number; readonly revision: string },
    action: (checkoutPath: string) => Promise<TResult>,
  ): Promise<TResult>;
}

export function createTargetCheckout(options: {
  readonly sourceRepositoryPath: string;
  readonly checkoutRoot?: string;
  readonly createJobDirectory?: () => string;
  readonly execute?: (
    file: string,
    arguments_: readonly string[],
    environment?: Readonly<Record<string, string>>,
  ) => Promise<{ readonly stdout: string; readonly stderr: string }>;
  readonly gitEnvironment?: Readonly<Record<string, string>>;
  readonly dependencyEnvironment?: Readonly<Record<string, string>>;
}): TargetCheckout {
  const execute = options.execute ?? (async (file, arguments_, environment) => {
    const result = await executeFile(file, arguments_, { env: environment });
    return { stdout: result.stdout, stderr: result.stderr };
  });
  const git = (arguments_: readonly string[]) => options.gitEnvironment === undefined
    ? execute("git", arguments_)
    : execute("git", arguments_, options.gitEnvironment);
  const npm = (arguments_: readonly string[]) => options.dependencyEnvironment === undefined
    ? execute("npm", arguments_)
    : execute("npm", arguments_, options.dependencyEnvironment);
  return {
    async withCheckout(request, action) {
      if (!/^[0-9a-f]{40}$/u.test(request.revision)) {
        throw new Error("Target Checkout requires a full Git revision");
      }
      const checkoutPath = options.createJobDirectory === undefined
        ? await (async () => {
          const checkoutRoot = options.checkoutRoot ?? tmpdir();
          await mkdir(checkoutRoot, { recursive: true, mode: 0o700 });
          return mkdtemp(join(checkoutRoot, `review-${request.pullRequestNumber ?? "job"}-`));
        })()
        : options.createJobDirectory();
      let completed = false;
      try {
        // Fetch and push against the GitHub remote resolved from the trusted
        // repository's origin, never the trusted repository itself, so Pull
        // Request refs and objects stay out of it.
        const remote = (await git([
          "-C", options.sourceRepositoryPath, "remote", "get-url", "origin",
        ])).stdout.trim();
        if (
          !/^https:\/\/[^/@\s]+(?:\/|$)/u.test(remote) ||
          /:\/\/[^/]*@/u.test(remote)
        ) {
          throw new Error("Target Checkout remote is invalid");
        }
        await git([
          "clone", "--no-checkout", "--no-local", remote, checkoutPath,
        ]);
        // Independent clones do not inherit repository-local configuration.
        // Copy the commit identity already required by Dispatcher startup into
        // this disposable checkout, never to the user's global config. Read it
        // with the same any-layer semantics as sandbox startup so global-only
        // identities work identically, and fail closed when it is absent.
        const readIdentityValue = async (key: string): Promise<string> => {
          try {
            return (await git([
              "-C", options.sourceRepositoryPath, "config", "--get", key,
            ])).stdout.trim();
          } catch (error) {
            // git exits 1 when the key is unset; treat that as an absent identity.
            if ((error as { code?: number }).code === 1) return "";
            throw error;
          }
        };
        const [name, email] = await Promise.all([
          readIdentityValue("user.name"),
          readIdentityValue("user.email"),
        ]);
        if (name.length === 0 || email.length === 0) {
          throw new Error(
            "The trusted repository checkout has no configured git user.name/user.email; " +
            "Target Checkout commits require a git identity",
          );
        }
        await git(["-C", checkoutPath, "config", "--local", "user.name", name]);
        await git(["-C", checkoutPath, "config", "--local", "user.email", email]);
        await git(["-C", checkoutPath, "fetch", "--no-tags", "origin", request.revision]);
        const fetched = (await git(["-C", checkoutPath, "rev-parse", "FETCH_HEAD"])).stdout.trim();
        if (fetched !== request.revision) {
          throw new Error("Target Checkout fetched an unexpected revision");
        }
        const trackedPrivateEnvironment = (await git([
          "-C", checkoutPath,
          "ls-tree", "-r", "--name-only", request.revision, "--", ".sandcastle/.env",
        ])).stdout.trim();
        if (trackedPrivateEnvironment.length > 0) {
          throw new Error("Target revision tracks a Sandcastle private environment file");
        }
        await git(["-C", checkoutPath, "checkout", "--detach", request.revision]);
        await npm(["--prefix", checkoutPath, "ci", "--ignore-scripts"]);
        const result = await action(checkoutPath);
        completed = true;
        return result;
      } finally {
        if (completed) {
          await rm(checkoutPath, { force: true, recursive: true });
        }
      }
    },
  };
}
