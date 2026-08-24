import { createSameSessionPrdSplitExtractor } from "./prd-split-extraction.ts";
import { loadSandboxStartup } from "./sandbox.ts";

const [prdNumber, title, checkoutPath, model] = process.argv.slice(2);
if (
  prdNumber === undefined ||
  title === undefined ||
  checkoutPath === undefined ||
  model === undefined
) {
  throw new Error("Expected PRD split worker arguments");
}

const startup = await loadSandboxStartup();
const slices = await createSameSessionPrdSplitExtractor({
  sandbox: startup.githubAgentSandbox,
  hooks: { sandbox: { onSandboxReady: [] } },
}).split({
  prdNumber: Number(prdNumber),
  title,
  checkoutPath,
  model,
});
console.log(JSON.stringify({ slices }));
