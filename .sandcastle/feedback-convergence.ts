// Bounded post-publication convergence for feedback implementation (#293).
// After the controlled publisher returns a POST, the orchestrator polls the
// read-only Pull Request head: a temporary observation of the acquired PRE is
// propagation, an explicitly transient read error may retry within the
// budget, a third-party SHA is a real race, and exhaustion is indeterminate
// so the caller must not repeat the push or reply.

export type FeedbackConvergence =
  | { readonly status: "converged"; readonly sha: string }
  | { readonly status: "indeterminate" }
  | { readonly status: "race"; readonly sha: string };

export async function convergeFeedbackHead(request: {
  readonly expectedPost: string;
  readonly acquiredPre: string;
  readonly readHead: () => Promise<string>;
  readonly isTransientReadError: (error: unknown) => boolean;
  readonly attempts: number;
  readonly wait: (attempt: number) => Promise<void>;
}): Promise<FeedbackConvergence> {
  const { expectedPost, acquiredPre, readHead, isTransientReadError, attempts, wait } = request;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let sha: string;
    try {
      sha = await readHead();
    } catch (error) {
      if (!isTransientReadError(error)) throw error;
      if (attempt === attempts - 1) return { status: "indeterminate" };
      await wait(attempt + 1);
      continue;
    }
    if (sha === expectedPost) return { status: "converged", sha };
    if (sha === acquiredPre) {
      if (attempt === attempts - 1) return { status: "indeterminate" };
      await wait(attempt + 1);
      continue;
    }
    return { status: "race", sha };
  }
  return { status: "indeterminate" };
}
