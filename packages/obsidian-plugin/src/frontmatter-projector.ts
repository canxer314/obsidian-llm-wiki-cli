import { TextDecoder } from "node:util";

import { isAlias, isMap, isNode, parseDocument, Scalar, visit } from "yaml";

import type { FrontmatterChange } from "./change-set.js";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

interface FrontmatterEnvelope {
  content: string;
  frontmatterStart: number;
  frontmatterEnd: number;
  newline: "\n" | "\r\n";
}

interface FieldRange {
  pairStart: number;
  pairEnd: number;
  valueStart: number;
  valueEnd: number;
  valuePrefix: string;
  valueSuffix: string;
  value: unknown;
}

interface SourceEdit {
  start: number;
  end: number;
  replacement: string;
}

function locateFrontmatter(bytes: Uint8Array): FrontmatterEnvelope | null {
  let content: string;
  try {
    content = utf8Decoder.decode(bytes);
  } catch {
    return null;
  }
  const markerStart = content.startsWith("﻿") ? 1 : 0;
  const firstBreak = content.indexOf("\n", markerStart);
  if (firstBreak < 0) return null;
  const firstLine = content.slice(markerStart, firstBreak + 1);
  const newline = firstLine.endsWith("\r\n") ? "\r\n" : "\n";
  if (firstLine !== `---${newline}`) return null;

  let lineStart = firstBreak + 1;
  while (lineStart <= content.length) {
    const lineBreak = content.indexOf("\n", lineStart);
    if (lineBreak < 0) return null;
    const line = content.slice(lineStart, lineBreak + 1);
    if (line === `---${newline}`) {
      const source = content.slice(firstBreak + 1, lineStart);
      const withoutExpectedBreaks = source.split(newline).join("");
      if (withoutExpectedBreaks.includes("\n") || withoutExpectedBreaks.includes("\r")) {
        return null;
      }
      return {
        content,
        frontmatterStart: firstBreak + 1,
        frontmatterEnd: lineStart,
        newline,
      };
    }
    lineStart = lineBreak + 1;
  }
  return null;
}

function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && jsonValuesEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function lineEndingAt(source: string, offset: number): number {
  if (source.startsWith("\r\n", offset)) return offset + 2;
  if (source.startsWith("\n", offset)) return offset + 1;
  return offset;
}

function renderValue(value: unknown): string {
  return JSON.stringify(value);
}

function renderPair(key: string, value: unknown, newline: string): string {
  return `${JSON.stringify(key)}: ${renderValue(value)}${newline}`;
}

export function projectFrontmatter(
  bytes: Uint8Array,
  changes: FrontmatterChange[],
): Uint8Array | null {
  const envelope = locateFrontmatter(bytes);
  if (envelope === null) return null;
  const source = envelope.content.slice(
    envelope.frontmatterStart,
    envelope.frontmatterEnd,
  );
  const document = parseDocument(source, {
    keepSourceTokens: true,
    uniqueKeys: true,
  });
  if (
    document.errors.length > 0 ||
    document.warnings.length > 0 ||
    (document.contents === null ? source.length !== 0 : !isMap(document.contents))
  ) {
    return null;
  }

  let unsafeNode = false;
  visit(document, {
    Node(_key, node) {
      if (isAlias(node) || node.anchor !== undefined || node.tag !== undefined) {
        unsafeNode = true;
        return visit.BREAK;
      }
      return undefined;
    },
  });
  if (unsafeNode) return null;

  const fields = new Map<string, FieldRange>();
  for (const pair of isMap(document.contents) ? document.contents.items : []) {
    if (!(pair.key instanceof Scalar) || typeof pair.key.value !== "string") return null;
    const pairStart = pair.key.range?.[0];
    const valueStart = pair.value?.range?.[0];
    const valueEnd = pair.value?.range?.[1];
    const rawPairEnd = pair.value?.range?.[2] ?? pair.key.range?.[2];
    if (
      pairStart === undefined ||
      valueStart === undefined ||
      valueEnd === undefined ||
      rawPairEnd === undefined ||
      fields.has(pair.key.value)
    ) {
      return null;
    }
    const value = isNode(pair.value) ? pair.value.toJSON() : null;
    if (!isJsonValue(value)) return null;
    const valueSource = source.slice(valueStart, valueEnd);
    fields.set(pair.key.value, {
      pairStart,
      pairEnd: lineEndingAt(source, rawPairEnd),
      valueStart,
      valueEnd,
      valuePrefix: valueStart === valueEnd ? " " : "",
      valueSuffix: valueSource.endsWith(envelope.newline) ? envelope.newline : "",
      value,
    });
  }

  const finalValues = new Map<string, unknown>(
    [...fields].map(([key, field]) => [key, structuredClone(field.value)]),
  );
  const retainedSourceKeys = new Set(fields.keys());
  const addedOrder: string[] = [];
  for (const change of changes) {
    if (change.kind === "remove") {
      finalValues.delete(change.key);
      retainedSourceKeys.delete(change.key);
      const addedIndex = addedOrder.indexOf(change.key);
      if (addedIndex >= 0) addedOrder.splice(addedIndex, 1);
      continue;
    }
    if (!retainedSourceKeys.has(change.key) && !finalValues.has(change.key)) {
      addedOrder.push(change.key);
    }
    finalValues.set(change.key, structuredClone(change.value));
  }

  const edits: SourceEdit[] = [];
  for (const [key, field] of fields) {
    if (!retainedSourceKeys.has(key)) {
      edits.push({ start: field.pairStart, end: field.pairEnd, replacement: "" });
      continue;
    }
    const finalValue = finalValues.get(key);
    if (jsonValuesEqual(field.value, finalValue)) continue;
    edits.push({
      start: field.valueStart,
      end: field.valueEnd,
      replacement: `${field.valuePrefix}${renderValue(finalValue)}${field.valueSuffix}`,
    });
  }
  const additions = addedOrder
    .filter((key) => finalValues.has(key))
    .map((key) => renderPair(key, finalValues.get(key), envelope.newline))
    .join("");
  if (additions.length > 0) {
    edits.push({ start: source.length, end: source.length, replacement: additions });
  }

  let projected = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    projected = `${projected.slice(0, edit.start)}${edit.replacement}${projected.slice(edit.end)}`;
  }
  return Buffer.from(
    `${envelope.content.slice(0, envelope.frontmatterStart)}${projected}${envelope.content.slice(envelope.frontmatterEnd)}`,
  );
}
