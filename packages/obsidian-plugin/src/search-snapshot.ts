import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

export interface SearchSnapshotDataSource {
  listMarkdownPaths(): Promise<string[]>;
  readBinary(path: string): Promise<ArrayBuffer | Uint8Array | null>;
}

export interface SearchSnapshotNote {
  readonly path: string;
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly content: string;
  readonly contentVersion: string;
  readonly sizeBytes: number;
}

export interface SearchSnapshot {
  readonly version: number;
  readonly notes: readonly SearchSnapshotNote[];
}

export type SearchSnapshotReadiness = "ready" | "building" | "unavailable";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareCanonicalPaths(left: string, right: string): number {
  const folded = compareUtf8(
    left.toLocaleLowerCase("en"),
    right.toLocaleLowerCase("en"),
  );
  return folded || compareUtf8(left, right);
}

function isCanonicalMarkdownPath(path: string): boolean {
  return (
    path.length > 3 &&
    path.endsWith(".md") &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("//") &&
    !path.split("/").some((part) => part === "." || part === "..")
  );
}

function freezeNote(path: string, raw: ArrayBuffer | Uint8Array): SearchSnapshotNote {
  const source = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const capturedBytes = Uint8Array.from(source);
  const note = {
    path,
    filename: path.slice(path.lastIndexOf("/") + 1),
    get bytes() {
      return Uint8Array.from(capturedBytes);
    },
    content: decoder.decode(capturedBytes),
    contentVersion: `sha256:${createHash("sha256").update(capturedBytes).digest("hex")}`,
    sizeBytes: capturedBytes.byteLength,
  };
  return Object.freeze(note);
}

export class SearchSnapshotManager {
  readonly #dataSource: SearchSnapshotDataSource;
  #current: SearchSnapshot | undefined;
  #version = 0;
  #readiness: SearchSnapshotReadiness = "unavailable";
  #building = false;

  constructor(dataSource: SearchSnapshotDataSource) {
    this.#dataSource = dataSource;
  }

  get readiness(): SearchSnapshotReadiness {
    return this.#readiness;
  }

  current(): SearchSnapshot | undefined {
    return this.#current;
  }

  async rebuild(dataSource: SearchSnapshotDataSource = this.#dataSource): Promise<void> {
    if (this.#building) throw new Error("Search Snapshot build already in progress");
    this.#building = true;
    this.#readiness = "building";

    try {
      const paths = await dataSource.listMarkdownPaths();
      const uniquePaths = new Set(paths);
      if (uniquePaths.size !== paths.length || paths.some((path) => !isCanonicalMarkdownPath(path))) {
        throw new Error("Search Snapshot source is inconsistent");
      }
      const notes = await Promise.all(
        [...uniquePaths].map(async (path) => {
          const bytes = await dataSource.readBinary(path);
          if (bytes === null) throw new Error("Search Snapshot source is inconsistent");
          return freezeNote(path, bytes);
        }),
      );
      notes.sort((left, right) => compareCanonicalPaths(left.path, right.path));
      const publication = Object.freeze({
        version: this.#version + 1,
        notes: Object.freeze(notes),
      });
      this.#version = publication.version;
      this.#current = publication;
      this.#readiness = "ready";
    } catch (error) {
      this.#readiness = "unavailable";
      throw error;
    } finally {
      this.#building = false;
    }
  }
}

export { compareCanonicalPaths };
