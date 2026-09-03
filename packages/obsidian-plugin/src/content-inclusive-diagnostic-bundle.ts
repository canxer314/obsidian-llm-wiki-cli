import { createHash } from "node:crypto";

import {
  parseDiagnosticVersionField,
  parseEvidence,
  type VersionField,
} from "./diagnostic-bundle.js";

/**
 * Versioned, structurally separate content-inclusive diagnostic bundle
 * (spec §9.4; the local Primary Operator command of Spec #41 / #167).
 *
 * This producer is deliberately separate from the standard diagnostic bundle:
 * it never extends {@link StandardDiagnosticBundleContent} and the standard
 * bundle never gains an optional content field. The emitted payload carries
 * exactly the explicitly selected Vault content plus a minimal trace of local
 * operational context (the Managed Vault Bridge versions), reused from the
 * same closed standard evidence seam via {@link parseEvidence}. No note body,
 * Vault-relative path, real Vault ID, queue, journal, or health evidence is
 * serialized, and unknown or content-bearing evidence fields fail before any
 * bundle is emitted.
 *
 * The bundle is generated only through a local interactive Primary Operator
 * command after a fresh confirmation; it is never an MCP tool result.
 */

export const CONTENT_INCLUSIVE_DIAGNOSTIC_BUNDLE_SCHEMA_VERSION = 1;
export const CONTENT_INCLUSIVE_DIAGNOSTIC_BUNDLE_VERSION = "1.0";
export const CONTENT_INCLUSIVE_DIAGNOSTIC_PURPOSE = "selected_content_diagnostic";
const CONTENT_INCLUSIVE_DIAGNOSTIC_SOURCE = "managed_vault_bridge";
const SELECTION_TRACER = "active_editor_selection";
const CHECKSUM_ALGORITHM = "sha256";

export interface ContentInclusiveDiagnosticTrace {
  readonly source: typeof CONTENT_INCLUSIVE_DIAGNOSTIC_SOURCE;
  readonly versions: VersionField;
}

export interface ContentInclusiveDiagnosticSelection {
  readonly tracer: typeof SELECTION_TRACER;
  /** The exact bytes of the explicitly selected content, and nothing else. */
  readonly content: string;
}

/** The content-inclusive bundle content (the checksum covers this exactly). */
export interface ContentInclusiveDiagnosticBundleContent {
  readonly schemaVersion: typeof CONTENT_INCLUSIVE_DIAGNOSTIC_BUNDLE_SCHEMA_VERSION;
  readonly bundleVersion: typeof CONTENT_INCLUSIVE_DIAGNOSTIC_BUNDLE_VERSION;
  readonly purpose: typeof CONTENT_INCLUSIVE_DIAGNOSTIC_PURPOSE;
  readonly trace: ContentInclusiveDiagnosticTrace;
  readonly selection: ContentInclusiveDiagnosticSelection;
}

export interface ContentInclusiveDiagnosticBundle
  extends ContentInclusiveDiagnosticBundleContent {
  readonly checksum: {
    readonly algorithm: typeof CHECKSUM_ALGORITHM;
    readonly canonicalPayload: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function incompatible(location: string): TypeError {
  return new TypeError(`Content-inclusive diagnostic is incompatible at ${location}`);
}

function requireExactRecord(
  value: unknown,
  keys: readonly string[],
  location: string,
): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length !== keys.length) {
    throw incompatible(location);
  }
  const allowed = new Set(keys);
  if (!Object.keys(value).every((key) => allowed.has(key))) throw incompatible(location);
  return value;
}

function requireString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.length === 0) throw incompatible(location);
  return value;
}

function parseVersionField(value: unknown, location: string): VersionField {
  return parseDiagnosticVersionField(value, location);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, member]) => [key, canonicalize(member)]),
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Serializes the content-inclusive bundle content canonically so a copied
 * bundle's checksum can be recomputed without the correlation salt or source
 * data.
 */
export function canonicalizeContentInclusivePayload(
  payload: ContentInclusiveDiagnosticBundleContent,
): string {
  return JSON.stringify(canonicalize(payload));
}

function sha256Digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

/**
 * Produces one fixed, closed content-inclusive diagnostic bundle from the
 * accepted standard evidence plus exactly the explicitly selected content.
 * The evidence is validated through the same closed standard evidence seam, so
 * unknown or content-bearing source fields fail before any bundle is emitted;
 * the selection is the only content that ever reaches the payload.
 */
export function createContentInclusiveDiagnosticBundle(
  evidence: unknown,
  selectedContent: string,
): ContentInclusiveDiagnosticBundle {
  if (typeof selectedContent !== "string" || selectedContent.length === 0) {
    throw new TypeError("Explicitly selected content is required");
  }
  const parsed = parseEvidence(evidence);
  const content: ContentInclusiveDiagnosticBundleContent = {
    schemaVersion: CONTENT_INCLUSIVE_DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
    bundleVersion: CONTENT_INCLUSIVE_DIAGNOSTIC_BUNDLE_VERSION,
    purpose: CONTENT_INCLUSIVE_DIAGNOSTIC_PURPOSE,
    trace: {
      source: CONTENT_INCLUSIVE_DIAGNOSTIC_SOURCE,
      versions: parsed.versions,
    },
    selection: { tracer: SELECTION_TRACER, content: selectedContent },
  };
  return {
    ...content,
    checksum: {
      algorithm: CHECKSUM_ALGORITHM,
      canonicalPayload: sha256Digest(canonicalizeContentInclusivePayload(content)),
    },
  };
}

function parseBundle(value: unknown): ContentInclusiveDiagnosticBundleContent {
  const root = requireExactRecord(
    value,
    ["schemaVersion", "bundleVersion", "purpose", "trace", "selection", "checksum"],
    "root",
  );
  if (root.schemaVersion !== CONTENT_INCLUSIVE_DIAGNOSTIC_BUNDLE_SCHEMA_VERSION) {
    throw incompatible("root.schemaVersion");
  }
  if (root.bundleVersion !== CONTENT_INCLUSIVE_DIAGNOSTIC_BUNDLE_VERSION) {
    throw incompatible("root.bundleVersion");
  }
  if (root.purpose !== CONTENT_INCLUSIVE_DIAGNOSTIC_PURPOSE) {
    throw incompatible("root.purpose");
  }
  const trace = requireExactRecord(root.trace, ["source", "versions"], "trace");
  if (trace.source !== CONTENT_INCLUSIVE_DIAGNOSTIC_SOURCE) {
    throw incompatible("trace.source");
  }
  const selection = requireExactRecord(
    root.selection,
    ["tracer", "content"],
    "selection",
  );
  if (selection.tracer !== SELECTION_TRACER) {
    throw incompatible("selection.tracer");
  }
  const content = requireString(selection.content, "selection.content");
  const checksum = requireExactRecord(
    root.checksum,
    ["algorithm", "canonicalPayload"],
    "checksum",
  );
  if (checksum.algorithm !== CHECKSUM_ALGORITHM) {
    throw incompatible("checksum.algorithm");
  }
  const canonicalPayload = requireString(checksum.canonicalPayload, "checksum.canonicalPayload");
  if (!SHA256_DIGEST.test(canonicalPayload)) throw incompatible("checksum.canonicalPayload");

  const parsedContent: ContentInclusiveDiagnosticBundleContent = {
    schemaVersion: CONTENT_INCLUSIVE_DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
    bundleVersion: CONTENT_INCLUSIVE_DIAGNOSTIC_BUNDLE_VERSION,
    purpose: CONTENT_INCLUSIVE_DIAGNOSTIC_PURPOSE,
    trace: {
      source: CONTENT_INCLUSIVE_DIAGNOSTIC_SOURCE,
      versions: parseVersionField(trace.versions, "trace.versions"),
    },
    selection: { tracer: SELECTION_TRACER, content },
  };
  const expected = sha256Digest(canonicalizeContentInclusivePayload(parsedContent));
  if (canonicalPayload !== expected) throw incompatible("checksum.canonicalPayload");
  return parsedContent;
}

/**
 * Verifies a copied content-inclusive bundle without needing any source data:
 * the structure is closed, only the selected content is present, and the
 * checksum is recomputed over the canonical payload.
 */
export function verifyContentInclusiveDiagnosticBundle(value: unknown): boolean {
  try {
    parseBundle(value);
    return true;
  } catch {
    return false;
  }
}
