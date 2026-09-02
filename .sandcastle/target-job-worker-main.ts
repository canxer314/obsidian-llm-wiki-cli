import {
  createTargetCheckout,
  type TargetCheckout,
  type TargetCheckoutProcessOptions,
} from "./target-checkout.ts";
import { parseTargetJobInput } from "./target-job-input.ts";
import {
  executeTargetOperationInCheckout,
  type AuthorizedTargetOperationInvocation,
} from "./target-operation.ts";
import type { TargetOperationStartupSnapshot } from "./target-operation-startup.ts";

interface TargetJobWorkerDependencies {
  readonly createCheckout: (options: TargetCheckoutProcessOptions) => TargetCheckout;
  readonly executeOperation: (options: {
    readonly checkout: TargetCheckout;
    readonly startup: TargetOperationStartupSnapshot;
    readonly invocation: AuthorizedTargetOperationInvocation;
  }) => Promise<unknown>;
}

const productionDependencies: TargetJobWorkerDependencies = {
  createCheckout: createTargetCheckout,
  executeOperation: executeTargetOperationInCheckout,
};

export async function runTargetJobWorker(
  serialized: string,
  dependencies: TargetJobWorkerDependencies = productionDependencies,
): Promise<unknown> {
  const job = parseTargetJobInput(serialized);
  return dependencies.executeOperation({
    checkout: dependencies.createCheckout(job.checkout),
    startup: job.startup,
    invocation: job.invocation,
  });
}
