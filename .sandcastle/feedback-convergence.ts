import type { GithubReadErrorClassification } from "./github-cli.ts";

// Bounded post-publication convergence for feedback implementation (#293).
// After the controlled publisher returns, reads distinguish short propagation
// from a rate limit, which gets one dedicated conservative retry.

export type FeedbackConvergence =
  | { readonly status: "converged"; readonly sha: string }
  | { readonly status: "indeterminate" }
  | { readonly status: "race"; readonly sha: string };

export async function convergeFeedbackHead(request: {
  readonly expectedPost: string;
  readonly acquiredPre: string;
  readonly readHead: () => Promise<string>;
  readonly classifyReadError: (error: unknown) => GithubReadErrorClassification;
  readonly attempts: number;
  readonly wait: (classification: GithubReadErrorClassification, attempt: number) => Promise<void>;
}): Promise<FeedbackConvergence> {
  const { expectedPost, acquiredPre, readHead, classifyReadError, attempts, wait } = request;
  let rateLimitRetried = false;
  let normalAttempts = 0;
  for (;;) {
    let sha: string;
    try {
      sha = await readHead();
    } catch (error) {
      const classification = classifyReadError(error);
      if (classification.kind === "deterministic") throw error;
      if (classification.kind === "rate-limited") {
        if (rateLimitRetried) return { status: "indeterminate" };
        rateLimitRetried = true;
        await wait(classification, normalAttempts + 1);
        continue;
      }
      if (normalAttempts === attempts - 1) return { status: "indeterminate" };
      normalAttempts += 1;
      await wait(classification, normalAttempts);
      continue;
    }
    if (sha === expectedPost) return { status: "converged", sha };
    if (sha === acquiredPre) {
      if (normalAttempts === attempts - 1) return { status: "indeterminate" };
      normalAttempts += 1;
      await wait({ kind: "transient" }, normalAttempts);
      continue;
    }
    return { status: "race", sha };
  }
}
