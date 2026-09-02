import { runTargetJobWorker } from "./target-job-worker-main.ts";
import { INHERITED_JOB_PROCESS_GROUP } from "./worker-process.ts";

try {
  if (process.env[INHERITED_JOB_PROCESS_GROUP] !== "1") {
    throw new Error("Target job worker requires an inherited process group");
  }
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  console.log(JSON.stringify(await runTargetJobWorker(input)));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
