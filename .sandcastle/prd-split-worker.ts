import { createSameSessionPrdSplitExtractor } from "./prd-split-extraction.ts";
import { readTargetWorkerStartup } from "./target-operation-startup.ts";

const [prdNumber, title, checkoutPath, model] = process.argv.slice(2);
if (
  prdNumber === undefined ||
  title === undefined ||
  checkoutPath === undefined ||
  model === undefined
) {
  throw new Error("Expected PRD split worker arguments");
}

const startup = await readTargetWorkerStartup();
const slices = await createSameSessionPrdSplitExtractor({
  sandbox: startup.sandbox,
  hooks: { sandbox: { onSandboxReady: [] } },
}).split({
  prdNumber: Number(prdNumber),
  title,
  checkoutPath,
  model,
});
console.log(JSON.stringify({ slices }));
