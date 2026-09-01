import { createTargetCheckout, type TargetCheckoutProcessOptions } from "./target-checkout.ts";
import { parseAuthorizedTargetOperationInvocation } from "./target-operation-invocation.ts";
import {
  executeTargetOperationInCheckout,
  type AuthorizedTargetOperationInvocation,
} from "./target-operation.ts";
import type { TargetOperationStartupSnapshot } from "./target-operation-startup.ts";
import { INHERITED_JOB_PROCESS_GROUP } from "./worker-process.ts";

interface TargetJobInput {
  readonly checkout: TargetCheckoutProcessOptions;
  readonly startup: TargetOperationStartupSnapshot;
  readonly invocation: AuthorizedTargetOperationInvocation;
}

try {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const job = JSON.parse(input) as TargetJobInput;
  if (process.env[INHERITED_JOB_PROCESS_GROUP] !== "1") {
    throw new Error("Target job worker requires an inherited process group");
  }

  const invocation = parseAuthorizedTargetOperationInvocation(job.invocation);
  console.log(JSON.stringify(await executeTargetOperationInCheckout({
    checkout: createTargetCheckout(job.checkout),
    startup: job.startup,
    invocation,
  })));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
