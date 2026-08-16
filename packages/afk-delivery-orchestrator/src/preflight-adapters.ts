export type PreflightCommand = (
  file: string,
  args: string[],
  environment?: Record<string, string>,
) => Promise<string>;

export function readPinnedSkillsManifestFromImage(
  image: string,
  command: PreflightCommand,
): Promise<string> {
  return command("docker", [
    "run",
    "--rm",
    "--network",
    "none",
    "--entrypoint",
    "cat",
    image,
    "/opt/afk-delivery/skills.lock",
  ]);
}

export function viewRepositoryWithCredential(
  repository: string,
  token: string,
  command: PreflightCommand,
): Promise<string> {
  return command("gh", [
    "repo",
    "view",
    repository,
    "--json",
    "nameWithOwner",
  ], {
    GITHUB_TOKEN: token,
    GH_TOKEN: token,
  });
}
