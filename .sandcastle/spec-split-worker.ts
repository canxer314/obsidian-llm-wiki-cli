import { createSameSessionSpecSplitExtractor } from "./spec-split-extraction.ts";
import { readTargetWorkerStartup } from "./target-operation-startup.ts";

const [specNumber, title, checkoutPath, model] = process.argv.slice(2);
if (
  specNumber === undefined ||
  title === undefined ||
  checkoutPath === undefined ||
  model === undefined
) {
  throw new Error("Expected Spec split worker arguments");
}

const startup = await readTargetWorkerStartup();
const slices = await createSameSessionSpecSplitExtractor({
  sandbox: startup.sandbox,
  hooks: { sandbox: { onSandboxReady: [] } },
  checkoutPath,
}).split({
  specNumber: Number(specNumber),
  title,
  model,
});
console.log(JSON.stringify({ slices }));
