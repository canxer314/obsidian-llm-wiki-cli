import { posix } from "node:path";

import type { ChangeSetOperation } from "@llm-wiki/vault-contracts";

import type {
  ChangeSetPreflightDataSource,
  MoveProjection,
} from "./change-set.js";
import {
  enumerateDecodedReferenceTargets,
  renderRegisteredReference,
  type CanonicalReferenceCandidate,
} from "./obsidian-search-data-source.js";
import type {
  SearchSnapshot,
  SearchSnapshotNote,
  SearchSnapshotReference,
} from "./search-snapshot.js";

type MoveOperation = Extract<ChangeSetOperation, { kind: "move" }>;

export interface MoveReferenceSnapshotSource {
  current(): SearchSnapshot | undefined;
}

function aliases(note: SearchSnapshotNote): string[] {
  const value = note.frontmatter?.aliases ?? note.frontmatter?.alias;
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((alias): alias is string => typeof alias === "string");
  return [];
}

function splitFragment(target: string): { fileLinkpath: string; fragment: string } {
  const block = target.lastIndexOf("#^");
  const separator = block >= 0 ? block : target.indexOf("#");
  return separator < 0
    ? { fileLinkpath: target, fragment: "" }
    : { fileLinkpath: target.slice(0, separator), fragment: target.slice(separator) };
}

function decodeLinkpath(reference: SearchSnapshotReference, fileLinkpath: string): string | null {
  if (reference.profile === "wikilink" || reference.profile === "embed") {
    return fileLinkpath;
  }
  try {
    return decodeURI(fileLinkpath);
  } catch {
    return null;
  }
}

// A literal "#" in the file portion of a target starts a fragment in every
// registered profile, so a moved note whose destination name contains one
// cannot be re-rendered without silently corrupting the link; reject the
// projection instead of rewriting (issue #38 AC6: ambiguity rejects).
function joinFileAndFragment(fileLinkpath: string, fragment: string): string | null {
  return fileLinkpath.includes("#") ? null : fileLinkpath + fragment;
}

// A rewritten markdown target is re-encoded by the renderer, which escapes
// every "%" as "%25". A fragment therefore only survives a rewrite when
// decoding it fully agrees with decodeURI: a reserved escape such as %23 (a
// heading containing "#") would otherwise be double-encoded into a dead
// anchor. Reject the projection instead of rewriting (issue #38 AC6).
function decodeFragmentForRewrite(
  reference: SearchSnapshotReference,
  fragment: string,
): string | null {
  const decoded = decodeLinkpath(reference, fragment);
  if (decoded === null) return null;
  if (reference.profile === "wikilink" || reference.profile === "embed") return decoded;
  try {
    return decodeURIComponent(fragment) === decoded ? decoded : null;
  } catch {
    return null;
  }
}

function resolvesUniquely(
  decodedLinkpath: string,
  candidates: readonly CanonicalReferenceCandidate[],
  sourcePath: string,
  destinationPath: string,
): boolean {
  const targets = enumerateDecodedReferenceTargets(decodedLinkpath, candidates, sourcePath);
  return targets.length === 1 && targets[0] === destinationPath;
}

function projectedCandidates(
  snapshot: SearchSnapshot,
  operation: MoveOperation,
): CanonicalReferenceCandidate[] {
  return snapshot.notes.map((note) => {
    const path = note.path === operation.sourcePath ? operation.destinationPath : note.path;
    const filename = path.slice(path.lastIndexOf("/") + 1);
    return {
      path,
      basename: filename.endsWith(".md") ? filename.slice(0, -3) : filename,
      aliases: aliases(note),
    };
  });
}

function renderedTarget(
  reference: SearchSnapshotReference,
  sourceNote: SearchSnapshotNote,
  operation: MoveOperation,
  candidates: readonly CanonicalReferenceCandidate[],
): string | null {
  const { fileLinkpath, fragment } = splitFragment(reference.target);
  if (fileLinkpath === "") {
    // A fragment-only target points inside the note holding it, so a move
    // leaves it resolving exactly as before; keep the original bytes rather
    // than decoding and re-encoding them.
    return sourceNote.path === operation.sourcePath ? fragment : null;
  }
  // Probes run on decoded linkpaths so decoding happens exactly once, here;
  // the renderer re-encodes markdown destinations when splicing them back.
  const decoded = decodeLinkpath(reference, fileLinkpath);
  if (decoded === null) return null;
  const keptExtension = decoded.endsWith(".md");
  const relativeStyle = decoded.startsWith("./") || decoded.startsWith("../");
  const destinationWithoutExtension = operation.destinationPath.slice(0, -3);
  const destinationName = destinationWithoutExtension.slice(
    destinationWithoutExtension.lastIndexOf("/") + 1,
  );
  const destination = keptExtension ? operation.destinationPath : destinationWithoutExtension;
  const shortDestination = keptExtension ? `${destinationName}.md` : destinationName;
  const projectedSourcePath = sourceNote.path === operation.sourcePath
    ? operation.destinationPath
    : sourceNote.path;
  if (resolvesUniquely(decoded, candidates, projectedSourcePath, operation.destinationPath)) {
    // The unchanged target still resolves to the destination, so nothing is
    // rewritten; hand the renderer the raw bytes to preserve the original
    // encoding style (AC3).
    return reference.target;
  }
  const decodedFragment = decodeFragmentForRewrite(reference, fragment);
  if (decodedFragment === null) return null;
  const hadExplicitPath = decoded.includes("/");
  let nextFileLinkpath = relativeStyle
    ? posix.relative(posix.dirname(projectedSourcePath), destination)
    : hadExplicitPath
      ? destination
      : shortDestination;
  if (relativeStyle && !nextFileLinkpath.startsWith(".")) {
    nextFileLinkpath = `./${nextFileLinkpath}`;
  }
  if (
    !resolvesUniquely(nextFileLinkpath, candidates, projectedSourcePath, operation.destinationPath)
  ) {
    nextFileLinkpath = destination;
  }
  if (
    !resolvesUniquely(nextFileLinkpath, candidates, projectedSourcePath, operation.destinationPath)
  ) return null;
  return joinFileAndFragment(nextFileLinkpath, decodedFragment);
}

function projectNote(
  note: SearchSnapshotNote,
  references: readonly SearchSnapshotReference[],
  operation: MoveOperation,
  candidates: readonly CanonicalReferenceCandidate[],
): Uint8Array | null {
  let projected = note.bytes;
  let nextStart = projected.byteLength;
  for (const reference of [...references].sort(
    (left, right) => right.startByte - left.startByte,
  )) {
    if (
      reference.startByte < 0 ||
      reference.endByteExclusive > nextStart ||
      reference.startByte >= reference.endByteExclusive ||
      !Buffer.from(
        projected.slice(reference.startByte, reference.endByteExclusive),
      ).equals(Buffer.from(reference.original))
    ) return null;
    let rendered: string;
    try {
      const target = renderedTarget(reference, note, operation, candidates);
      if (target === null) return null;
      rendered = renderRegisteredReference(reference.profile, reference.original, target, "note");
    } catch {
      return null;
    }
    const prefix = projected.slice(0, reference.startByte);
    const suffix = projected.slice(reference.endByteExclusive);
    projected = Buffer.concat([prefix, Buffer.from(rendered), suffix]);
    nextStart = reference.startByte;
  }
  return projected;
}

export function createMoveReferenceProjector(
  snapshots: MoveReferenceSnapshotSource,
): NonNullable<ChangeSetPreflightDataSource["projectMove"]> {
  return async (operation): Promise<MoveProjection | null> => {
    const snapshot = snapshots.current();
    if (snapshot === undefined) return null;
    const source = snapshot.notes.find((note) => note.path === operation.sourcePath);
    if (source === undefined || source.contentVersion !== operation.targetVersion) return null;
    if (snapshot.notes.some((note) => note.path === operation.destinationPath)) return null;

    const candidates = projectedCandidates(snapshot, operation);
    const derivedEffects: MoveProjection["derivedEffects"] = [];
    for (const note of snapshot.notes) {
      const references = note.references.filter(
        (reference) => reference.resolvedPath === operation.sourcePath,
      );
      const graphCount = note.resolvedLinks[operation.sourcePath] ?? 0;
      if (references.length !== graphCount) return null;
      if (graphCount === 0) continue;
      const projectedBytes = projectNote(note, references, operation, candidates);
      if (projectedBytes === null) return null;
      derivedEffects.push({
        operationId: `derived/${operation.operationId}/references/${note.path}`,
        path: note.path,
        targetVersion: note.contentVersion,
        projectedBytes,
        referenceCount: references.length,
      });
    }
    return { derivedEffects };
  };
}

export function withMoveReferenceProjection(
  dataSource: ChangeSetPreflightDataSource,
  snapshots: MoveReferenceSnapshotSource,
): ChangeSetPreflightDataSource {
  return { ...dataSource, projectMove: createMoveReferenceProjector(snapshots) };
}
