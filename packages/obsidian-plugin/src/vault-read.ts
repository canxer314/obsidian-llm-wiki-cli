import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import {
  parseReadResult,
  type ReadInput,
  type ReadRequest,
  type ReadResult,
  type TypedReadResult,
} from "@llm-wiki/vault-contracts";

export const MAXIMUM_LOGICAL_EXACT_READ_BYTES = 1_048_576;

export interface VaultReadHeading {
  heading: string;
  level: number;
  startOffset: number;
  endOffset: number;
}

export interface VaultReadDataSource {
  readBinary(path: string): Promise<ArrayBuffer | Uint8Array | null>;
  parseFrontmatter(content: string): Record<string, unknown> | null;
  headings(path: string): VaultReadHeading[] | null;
}

interface RawSnapshot {
  bytes: Uint8Array;
  content: string;
  contentVersion: string;
}

interface ParsedHeading {
  heading: string;
  level: number;
  hierarchy: string[];
  start: number;
  end: number;
}

type ReadItemResult = Extract<ReadResult, { outcome: "items" }>["items"][number];

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function freezeBytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  const source = value instanceof Uint8Array ? value : new Uint8Array(value);
  return Uint8Array.from(source);
}

async function readSnapshot(
  dataSource: VaultReadDataSource,
  path: string,
): Promise<RawSnapshot | null> {
  const raw = await dataSource.readBinary(path);
  if (raw === null) return null;
  const bytes = freezeBytes(raw);
  return {
    bytes,
    content: utf8Decoder.decode(bytes),
    contentVersion: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function verifyHeadings(
  content: string,
  cached: VaultReadHeading[] | null,
): ParsedHeading[] | null {
  if (cached === null) return null;
  const headings: ParsedHeading[] = [];
  const hierarchy: string[] = [];
  const hostOffset = content.startsWith("﻿") ? 1 : 0;

  for (const candidate of cached) {
    const startOffset = candidate.startOffset + hostOffset;
    const endOffset = candidate.endOffset + hostOffset;
    if (
      candidate.level < 1 ||
      candidate.level > 6 ||
      startOffset < hostOffset ||
      endOffset <= startOffset ||
      endOffset > content.length
    ) {
      return null;
    }
    const original = content.slice(startOffset, endOffset);
    const atxHeadingPattern = new RegExp(
      `^ {0,3}#{${candidate.level}}[\\t ]+${escapeRegularExpression(candidate.heading)}[\\t ]*#*[\\t ]*$`,
      "u",
    );
    const setextHeadingPattern =
      candidate.level <= 2
        ? new RegExp(
            `^${escapeRegularExpression(candidate.heading)}[\\t ]*(?:\\r\\n|\\n|\\r) {0,3}${candidate.level === 1 ? "=" : "-"}+[\\t ]*$`,
            "u",
          )
        : null;
    if (!atxHeadingPattern.test(original) && !setextHeadingPattern?.test(original)) {
      return null;
    }
    hierarchy.length = candidate.level - 1;
    hierarchy[candidate.level - 1] = candidate.heading;
    headings.push({
      heading: candidate.heading,
      level: candidate.level,
      hierarchy: hierarchy.filter((part): part is string => part !== undefined),
      start: startOffset,
      end: content.length,
    });
  }

  for (const [index, heading] of headings.entries()) {
    const next = headings
      .slice(index + 1)
      .find((candidate) => candidate.level <= heading.level);
    heading.end = next?.start ?? content.length;
  }
  return headings;
}

function evidence(
  request: ReadRequest,
  index: number,
  snapshot: RawSnapshot,
): Pick<TypedReadResult, "index" | "path" | "contentVersion" | "sizeBytes"> {
  return {
    index,
    path: request.path,
    contentVersion: snapshot.contentVersion,
    sizeBytes: snapshot.bytes.byteLength,
  };
}

async function satisfyRequest(
  dataSource: VaultReadDataSource,
  request: ReadRequest,
  index: number,
): Promise<ReadItemResult> {
  const snapshot = await readSnapshot(dataSource, request.path);
  if (snapshot === null) return { outcome: "not_satisfied" };
  const common = evidence(request, index, snapshot);

  if (request.kind === "exact") {
    if (snapshot.bytes.byteLength > MAXIMUM_LOGICAL_EXACT_READ_BYTES) {
      return { outcome: "note_exceeds_exact_read_limit" };
    }
    return {
      outcome: "satisfied",
      result: { kind: "exact", ...common, content: snapshot.content },
    };
  }

  if (request.kind === "metadata") {
    return {
      outcome: "satisfied",
      result: {
        kind: "metadata",
        ...common,
        frontmatter: dataSource.parseFrontmatter(snapshot.content),
      },
    };
  }

  const parsedHeadings = verifyHeadings(
    snapshot.content,
    dataSource.headings(request.path),
  );
  if (parsedHeadings === null) return { outcome: "not_satisfied" };
  if (request.kind === "outline") {
    return {
      outcome: "satisfied",
      result: {
        kind: "outline",
        ...common,
        headings: parsedHeadings.map(({ heading, level }) => ({ heading, level })),
      },
    };
  }

  const matching = parsedHeadings.filter(
    (heading) =>
      heading.hierarchy.length === request.hierarchy.length &&
      heading.hierarchy.every((part, hierarchyIndex) => part === request.hierarchy[hierarchyIndex]),
  );
  const selected = matching[request.occurrence - 1];
  if (selected === undefined) return { outcome: "not_satisfied" };
  return {
    outcome: "satisfied",
    result: {
      kind: "section",
      ...common,
      hierarchy: request.hierarchy,
      occurrence: request.occurrence,
      content: snapshot.content.slice(selected.start, selected.end),
    },
  };
}

export async function performVaultRead(
  dataSource: VaultReadDataSource,
  input: ReadInput,
): Promise<ReadResult> {
  const items = await Promise.all(
    input.items.map((request, index) => satisfyRequest(dataSource, request, index)),
  );
  const exactReadBytes = items.map((item) =>
    item.outcome === "satisfied" && item.result.kind === "exact"
      ? item.result.sizeBytes
      : 0,
  );
  const logicalExactReadBytes = exactReadBytes.reduce((total, size) => total + size, 0);
  const containsOversizedNote = items.some(
    (item) => item.outcome === "note_exceeds_exact_read_limit",
  );

  if (
    !containsOversizedNote &&
    logicalExactReadBytes > MAXIMUM_LOGICAL_EXACT_READ_BYTES
  ) {
    const suggestedGroups: Array<{
      startIndex: number;
      endIndexExclusive: number;
      exactReadBytes: number;
    }> = [];
    let startIndex = 0;
    let groupBytes = 0;
    for (const [index, size] of exactReadBytes.entries()) {
      if (groupBytes + size > MAXIMUM_LOGICAL_EXACT_READ_BYTES) {
        suggestedGroups.push({
          startIndex,
          endIndexExclusive: index,
          exactReadBytes: groupBytes,
        });
        startIndex = index;
        groupBytes = 0;
      }
      groupBytes += size;
    }
    suggestedGroups.push({
      startIndex,
      endIndexExclusive: input.items.length,
      exactReadBytes: groupBytes,
    });
    return parseReadResult({ outcome: "grouping_required", suggestedGroups });
  }

  return parseReadResult({ outcome: "items", items });
}
