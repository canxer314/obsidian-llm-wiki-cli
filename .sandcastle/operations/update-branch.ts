import { runTargetOperation } from "../target-operation-runtime.ts";

console.log(JSON.stringify(await runTargetOperation("update-branch")));
