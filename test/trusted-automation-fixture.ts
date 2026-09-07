import { cp, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// A Target job resolves its operation entry and every nested worker from the
// trusted automation .sandcastle, never from the operated Target Checkout. For
// whole-job tests that must control the operation code that runs, build a
// fixture trusted automation checkout: a copy of this repository's automation
// code with a caller-supplied operation entry in place of the real one. The
// fixture links the repository node_modules so bare-specifier imports resolve
// exactly as they do for the production automation checkout.
export async function createTrustedAutomationFixture(
  root: string,
  entry: string,
  operationSource: string,
): Promise<string> {
  const automationPath = resolve(root, "automation");
  const sandcastlePath = resolve(automationPath, ".sandcastle");
  const repositorySandcastle = resolve(import.meta.dirname, "../.sandcastle");
  const repositoryRoot = resolve(repositorySandcastle, "..");
  await cp(repositorySandcastle, sandcastlePath, { recursive: true });
  await writeFile(resolve(sandcastlePath, "operations", entry), operationSource);
  await symlink(
    resolve(repositoryRoot, "node_modules"),
    resolve(automationPath, "node_modules"),
    "dir",
  );
  return sandcastlePath;
}
