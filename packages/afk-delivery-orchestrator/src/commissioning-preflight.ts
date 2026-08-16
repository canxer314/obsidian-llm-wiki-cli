import type { WorkerPreflightResult } from "./index.js";

export interface GitHubAppCredential {
  token: string;
  actorLogin: string;
  actorType: "Bot";
}

export interface CommissioningPreflightPorts {
  expectedRepository: string;
  issueCredential(repository: string): Promise<GitHubAppCredential>;
  preflight(credential: GitHubAppCredential): Promise<WorkerPreflightResult>;
}

export async function runCommissioningPreflight(
  ports: CommissioningPreflightPorts,
): Promise<WorkerPreflightResult> {
  const credential = await ports.issueCredential(ports.expectedRepository);
  return ports.preflight(credential);
}
