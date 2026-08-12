import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
  parseContinueResult,
  parseReadResult,
  type ContinuePageResult,
  type ContinueResult,
  type ReadResult,
} from "@llm-wiki/vault-contracts";

export const MAXIMUM_COMPACT_RESPONSE_BYTES = 262_144;
export const CONTINUATION_LIFETIME_MILLISECONDS = 15 * 60_000;
export const MAXIMUM_ACTIVE_CHAINS_PER_CLIENT = 8;
export const MAXIMUM_RETAINED_BYTES_PER_CLIENT = 8 * 1_048_576;

type ReadItemResult = Extract<ReadResult, { outcome: "items" }>["items"][number];
type SatisfiedReadItem = Extract<ReadItemResult, { outcome: "satisfied" }>;
type ContentReadResult = Extract<
  SatisfiedReadItem["result"],
  { kind: "exact" | "section" }
>;
type NonContentReadItem = Exclude<ReadItemResult, SatisfiedReadItem> | {
  outcome: "satisfied";
  result: Exclude<SatisfiedReadItem["result"], ContentReadResult>;
};

interface FrozenWholeItem {
  type: "whole";
  index: number;
  item: NonContentReadItem;
}

interface FrozenItemChunk {
  type: "item";
  index: number;
  start: number;
  sizeBytes: number;
  bytes: Uint8Array;
}

interface FrozenContentItem {
  type: "content";
  kind: ContentReadResult["kind"];
  index: number;
  path: string;
  contentVersion: string;
  sizeBytes: number;
  hierarchy?: string[];
  occurrence?: number;
  start: number;
  bytes: Uint8Array;
}

type FrozenItem = FrozenWholeItem | FrozenItemChunk | FrozenContentItem;

interface ContinuationState {
  clientId: string;
  chainId: string;
  items: FrozenItem[];
  retainedBytes: number;
  expiresAt: number;
}

export interface VaultContinuationStoreOptions {
  token?: () => string;
  now?: () => number;
  measureResponse?: (result: ContinuePageResult) => number;
}

export interface VaultContinuationStore {
  issue(clientId: string, result: ReadResult): ContinueResult;
  continue(clientId: string, continuation: string): ContinueResult;
  releaseClient(clientId: string): void;
}

function isUtf8ContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

function legalUtf8Prefix(bytes: Uint8Array, requestedEnd: number): number {
  let end = Math.min(requestedEnd, bytes.byteLength);
  while (end > 0 && isUtf8ContinuationByte(bytes[end])) end -= 1;
  return end;
}

function freezeItems(result: ReadResult): FrozenItem[] {
  const frozen = parseReadResult(result);
  if (frozen.outcome !== "items") return [];

  return frozen.items.map((item, index): FrozenItem => {
    if (
      item.outcome === "satisfied" &&
      (item.result.kind === "exact" || item.result.kind === "section")
    ) {
      const bytes = Uint8Array.from(Buffer.from(item.result.content, "utf8"));
      if (item.result.kind === "exact" && bytes.byteLength !== item.result.sizeBytes) {
        throw new Error("Exact Read content does not match its frozen byte size");
      }
      return {
        type: "content",
        kind: item.result.kind,
        index: item.result.index,
        path: item.result.path,
        contentVersion: item.result.contentVersion,
        sizeBytes: item.result.sizeBytes,
        ...(item.result.kind === "section"
          ? {
              hierarchy: [...item.result.hierarchy],
              occurrence: item.result.occurrence,
            }
          : {}),
        start: 0,
        bytes,
      };
    }

    return {
      type: "whole",
      index,
      item: item as NonContentReadItem,
    };
  });
}

function retainedBytes(items: FrozenItem[]): number {
  return items.reduce(
    (total, item) =>
      total +
      (item.type === "content" || item.type === "item"
        ? item.bytes.byteLength
        : Buffer.byteLength(JSON.stringify(item.item), "utf8")),
    0,
  );
}

function contentChunk(
  item: FrozenContentItem,
  end: number,
  complete: boolean,
): ContinuePageResult["items"][number] {
  const common = {
    index: item.index,
    path: item.path,
    contentVersion: item.contentVersion,
    sizeBytes: item.sizeBytes,
    start: item.start,
    end: item.start + end,
    content: Buffer.from(item.bytes.subarray(0, end)).toString("utf8"),
    complete,
  };
  if (item.kind === "exact") return { kind: "exact", ...common };
  return {
    kind: "section",
    ...common,
    hierarchy: item.hierarchy!,
    occurrence: item.occurrence!,
  };
}

function wholeItem(item: FrozenWholeItem): ContinuePageResult["items"][number] {
  return { index: item.index, item: item.item };
}

function itemChunk(
  item: FrozenItemChunk,
  end: number,
): ContinuePageResult["items"][number] {
  return {
    kind: "item",
    index: item.index,
    sizeBytes: item.sizeBytes,
    start: item.start,
    end: item.start + end,
    content: Buffer.from(item.bytes.subarray(0, end)).toString("utf8"),
    complete: item.start + end === item.sizeBytes,
  };
}

function freezeWholeItem(item: FrozenWholeItem): FrozenItemChunk {
  const bytes = Uint8Array.from(Buffer.from(JSON.stringify(item.item), "utf8"));
  return {
    type: "item",
    index: item.index,
    start: 0,
    sizeBytes: bytes.byteLength,
    bytes,
  };
}

function page(
  items: ContinuePageResult["items"],
  continuation: string | null,
): ContinuePageResult {
  return parseContinueResult({
    outcome: "page",
    items,
    continuation,
    complete: continuation === null,
  }) as ContinuePageResult;
}

function compactSize(value: ContinuePageResult): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function trimContent(item: FrozenContentItem, deliveredBytes: number): FrozenContentItem {
  return {
    ...item,
    start: item.start + deliveredBytes,
    bytes: Uint8Array.from(item.bytes.subarray(deliveredBytes)),
  };
}

function trimItem(item: FrozenItemChunk, deliveredBytes: number): FrozenItemChunk {
  return {
    ...item,
    start: item.start + deliveredBytes,
    bytes: Uint8Array.from(item.bytes.subarray(deliveredBytes)),
  };
}

function frozenChunk(
  item: FrozenItemChunk | FrozenContentItem,
  end: number,
): ContinuePageResult["items"][number] {
  return item.type === "item"
    ? itemChunk(item, end)
    : contentChunk(item, end, end === item.bytes.byteLength);
}

function trimFrozenChunk(
  item: FrozenItemChunk | FrozenContentItem,
  deliveredBytes: number,
): FrozenItemChunk | FrozenContentItem {
  return item.type === "item"
    ? trimItem(item, deliveredBytes)
    : trimContent(item, deliveredBytes);
}

function nextState(state: ContinuationState, items: FrozenItem[]): ContinuationState {
  return { ...state, items, retainedBytes: retainedBytes(items) };
}

function buildPage(
  state: ContinuationState,
  replacementToken: string,
  measureResponse: (result: ContinuePageResult) => number,
): { result: ContinuePageResult; next: ContinuationState | null } {
  const transported: ContinuePageResult["items"] = [];
  const remaining = [...state.items];

  while (remaining.length > 0) {
    const item = remaining[0]!;
    if (item.type === "whole") {
      const hasLaterItem = remaining.length > 1;
      const candidate = page(
        [...transported, wholeItem(item)],
        hasLaterItem ? replacementToken : null,
      );
      if (measureResponse(candidate) <= MAXIMUM_COMPACT_RESPONSE_BYTES) {
        transported.push(wholeItem(item));
        remaining.shift();
        if (!hasLaterItem) return { result: candidate, next: null };
        continue;
      }
      if (transported.length > 0) {
        return {
          result: page(transported, replacementToken),
          next: nextState(state, remaining),
        };
      }
      remaining[0] = freezeWholeItem(item);
      continue;
    }

    const hasLaterItem = remaining.length > 1;
    const fullChunk = frozenChunk(item, item.bytes.byteLength);
    const fullPage = page(
      [...transported, fullChunk],
      hasLaterItem ? replacementToken : null,
    );
    if (measureResponse(fullPage) <= MAXIMUM_COMPACT_RESPONSE_BYTES) {
      transported.push(fullChunk);
      remaining.shift();
      if (!hasLaterItem) return { result: fullPage, next: null };
      continue;
    }

    let low = 1;
    let high = item.bytes.byteLength;
    let bestEnd: number | undefined;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const end = legalUtf8Prefix(item.bytes, middle);
      if (end === 0) {
        low = middle + 1;
        continue;
      }
      const candidate = page(
        [...transported, frozenChunk(item, end)],
        replacementToken,
      );
      if (measureResponse(candidate) <= MAXIMUM_COMPACT_RESPONSE_BYTES) {
        bestEnd = end;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    if (bestEnd !== undefined) {
      const result = page(
        [...transported, frozenChunk(item, bestEnd)],
        replacementToken,
      );
      remaining[0] = trimFrozenChunk(item, bestEnd);
      return { result, next: nextState(state, remaining) };
    }

    if (transported.length > 0) {
      return {
        result: page(transported, replacementToken),
        next: nextState(state, remaining),
      };
    }

    throw new Error("Compact response cannot carry one UTF-8 character and its evidence");
  }

  throw new Error("Continuation has no frozen result items");
}

export function createVaultContinuationStore(
  options: VaultContinuationStoreOptions = {},
): VaultContinuationStore {
  const createToken = options.token ?? randomUUID;
  const now = options.now ?? Date.now;
  const measureResponse = options.measureResponse ?? compactSize;
  const active = new Map<string, ContinuationState>();

  function removeExpired(): void {
    const current = now();
    for (const [token, state] of active) {
      if (current >= state.expiresAt) active.delete(token);
    }
  }

  function clientUsage(clientId: string): { chains: number; bytes: number } {
    const states = [...active.values()].filter((state) => state.clientId === clientId);
    return {
      chains: states.length,
      bytes: states.reduce((total, state) => total + state.retainedBytes, 0),
    };
  }

  function nextToken(excludedToken?: string): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const token = createToken();
      if (token.length > 0 && token !== excludedToken && !active.has(token)) {
        return token;
      }
    }
    throw new Error("Continuation token source did not produce an available token");
  }

  function deliver(state: ContinuationState, consumedToken: string): ContinuePageResult {
    const replacementToken = nextToken(consumedToken);
    const { result, next } = buildPage(state, replacementToken, measureResponse);
    if (next !== null) {
      active.set(replacementToken, {
        ...next,
        expiresAt: now() + CONTINUATION_LIFETIME_MILLISECONDS,
      });
    }
    return result;
  }

  return {
    issue(clientId, result) {
      removeExpired();
      const items = freezeItems(result);
      if (items.length === 0) {
        throw new Error("Continuation requires an accepted ordered read result");
      }
      const chainId = nextToken();
      const initialState: ContinuationState = {
        clientId,
        chainId,
        items,
        retainedBytes: retainedBytes(items),
        expiresAt: now() + CONTINUATION_LIFETIME_MILLISECONDS,
      };
      const { result: pageResult, next } = buildPage(
        initialState,
        chainId,
        measureResponse,
      );
      if (next === null) return pageResult;

      const usage = clientUsage(clientId);
      if (
        usage.chains >= MAXIMUM_ACTIVE_CHAINS_PER_CLIENT ||
        usage.bytes + next.retainedBytes > MAXIMUM_RETAINED_BYTES_PER_CLIENT
      ) {
        return parseContinueResult({ code: "continuation_unavailable" });
      }
      active.set(chainId, next);
      return pageResult;
    },
    continue(clientId, continuation) {
      removeExpired();
      const state = active.get(continuation);
      if (state === undefined || state.clientId !== clientId) {
        return parseContinueResult({ code: "continuation_unavailable" });
      }
      active.delete(continuation);
      return deliver(state, continuation);
    },
    releaseClient(clientId) {
      removeExpired();
      for (const [token, state] of active) {
        if (state.clientId === clientId) active.delete(token);
      }
    },
  };
}
