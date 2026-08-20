import { runSandcastleCli } from "../../.sandcastle/cli.ts";

const signalName = process.argv[2] ?? "SIGTERM";
const issue = { number: 207, state: "OPEN", labels: ["Sandcastle"] };

try {
  await runSandcastleCli(["--issue", "207", "--no-live-status"], {
    github: {
      ensureLabel: async () => undefined,
      getIssue: async () => issue,
      listCandidateIssues: async () => [],
      claimIssue: async () => true,
    },
    warningSink: (line) => console.error(line),
    processIssue: async (_number, execution) => {
      const inFlightAgent = setInterval(() => undefined, 1_000);
      const teardown = new Promise<void>((resolve) => {
        execution.signal.addEventListener("abort", () => setTimeout(resolve, 20), { once: true });
      });
      console.log(`ready:${signalName}`);
      await teardown;
      clearInterval(inFlightAgent);
      console.log("teardown-complete");
      throw execution.signal.reason;
    },
  });
} catch (error) {
  console.error(error instanceof Error ? error.name : "Error");
  process.exitCode = 1;
}
