import { readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type {
  ChangeSetPathKind,
  ChangeSetPreflightDataSource,
} from "./change-set.js";
import { projectFrontmatter } from "./frontmatter-projector.js";

interface FileSystemVaultAdapter {
  exists(path: string): Promise<boolean>;
  readBinary(path: string): Promise<ArrayBuffer>;
  stat(path: string): Promise<{ type: "file" | "folder" } | null>;
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

async function hasCanonicalSpelling(root: string, path: string): Promise<boolean> {
  let directory = root;
  for (const segment of path.split("/")) {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      return true;
    }
    if (names.includes(segment)) {
      directory = resolve(directory, segment);
      continue;
    }
    const folded = segment.toLocaleLowerCase("en-US");
    const aliases = names.filter(
      (name) =>
        name.toLocaleLowerCase("en-US") === folded ||
        name.normalize("NFC") === segment.normalize("NFC"),
    );
    return aliases.length === 0;
  }
  return true;
}

async function isContained(root: string, basePath: string, path: string): Promise<boolean> {
  if (isAbsolute(path)) return false;
  const resolved = resolve(basePath, path);
  if (!isWithin(root, resolved)) return false;

  let candidate = resolved;
  while (candidate !== basePath) {
    try {
      candidate = await realpath(candidate);
      break;
    } catch {
      candidate = dirname(candidate);
    }
  }
  return isWithin(root, candidate) && hasCanonicalSpelling(root, path);
}

export function createFileSystemChangeSetDataSource(
  basePath: string,
  adapter: FileSystemVaultAdapter,
): ChangeSetPreflightDataSource {
  const root = realpath(basePath);
  return {
    readBinary: async (path) =>
      (await adapter.exists(path)) ? adapter.readBinary(path) : null,
    pathKind: async (path): Promise<ChangeSetPathKind | null> => {
      const stat = await adapter.stat(path);
      if (stat === null) return null;
      return stat.type === "folder" ? "directory" : "file";
    },
    isContained: async (path) => isContained(await root, basePath, path),
    projectFrontmatter: async (bytes, changes) => projectFrontmatter(bytes, changes),
  };
}
