import {
  hasExactOwnKeys,
  ownDataPropertyValues,
} from "./protocol-record.ts";
import {
  targetCheckoutProcessOptions,
  type TargetCheckoutProcessOptions,
} from "./target-checkout.ts";
import {
  parseAuthorizedTargetOperationInvocation,
  type AuthorizedTargetOperationInvocation,
} from "./target-operation-invocation.ts";
import {
  targetOperationStartupSnapshot,
  type TargetOperationStartupSnapshot,
} from "./target-operation-startup.ts";

interface TargetJobInput {
  readonly checkout: TargetCheckoutProcessOptions;
  readonly startup: TargetOperationStartupSnapshot;
  readonly invocation: AuthorizedTargetOperationInvocation;
}

const targetJobInputKeys = new Set(["checkout", "startup", "invocation"]);

export function parseTargetJobInput(serialized: string): TargetJobInput {
  if (serialized.length === 0) throw new Error("Target job input is missing");
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Target job input is invalid");
  }
  const input = ownDataPropertyValues(value);
  if (
    input === undefined || !hasExactOwnKeys(input, targetJobInputKeys)
  ) throw new Error("Target job input is invalid");
  const invocation = parseAuthorizedTargetOperationInvocation(input.invocation);
  const checkout = targetCheckoutProcessOptions(input.checkout);
  const startup = targetOperationStartupSnapshot(input.startup);
  return Object.freeze({ checkout, startup, invocation });
}
