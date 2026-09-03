/**
 * Byte-diverse Markdown fixtures for the process-crash corpus (issue #188).
 *
 * Every fixture is authored as exact JS strings and encoded with `TextEncoder`
 * so the on-disk bytes are fully deterministic. The set deliberately mixes
 * UTF-8 BOM, LF and CRLF line endings, CJK, astral (non-BMP) Unicode, and
 * untouched Frontmatter/body representations so recovery and replay cannot
 * "normalize" bytes the Change Set never intended to touch.
 */

import { projectFrontmatter } from "../frontmatter-projector.js";

const textEncoder = new TextEncoder();

export interface ReplaceExactFixture {
  readonly path: string;
  readonly originalText: string;
  readonly oldText: string;
  readonly replacementText: string;
}

export interface ReplaceWholeFixture {
  readonly path: string;
  readonly originalText: string;
  readonly replacementText: string;
}

export interface FrontmatterFixture {
  readonly path: string;
  readonly originalText: string;
  readonly changes: ReadonlyArray<
    | { readonly kind: "set"; readonly key: string; readonly value: unknown }
    | { readonly kind: "remove"; readonly key: string }
  >;
}

function encode(text: string): Uint8Array {
  return textEncoder.encode(text);
}

/**
 * `replace_exact` fixture: BOM + CRLF/LF mix + CJK + astral Unicode. The
 * replaced span is a unique CJK/astral phrase so an exact single-occurrence
 * match is unambiguous and every untouched byte (BOM, line endings, the rest of
 * the body) must survive byte-for-byte.
 */
export const EXACT_FIXTURE: ReplaceExactFixture = {
  path: "Corpus/Edits/Exact.md",
  originalText:
    "﻿" +
    "# Título del corpus\r\n" +
    "\r\n" +
    "Este cuerpo mezcla LF y CRLF.\n" +
    "Una línea con 你好 y 🚀 emoji astral.\r\n" +
    "\r\n" +
    "- ítem uno\n" +
    "- ítem dos\r\n" +
    "\r\n" +
    "fin sin salto",
  oldText: "你好 y 🚀 emoji astral",
  replacementText: "你好 y 【reemplazo astral】🚀",
};

export const EXACT_ORIGINAL_BYTES: Uint8Array = encode(EXACT_FIXTURE.originalText);
export const EXACT_COMMITTED_TEXT: string = EXACT_FIXTURE.originalText.replace(
  EXACT_FIXTURE.oldText,
  EXACT_FIXTURE.replacementText,
);
export const EXACT_COMMITTED_BYTES: Uint8Array = encode(EXACT_COMMITTED_TEXT);

/**
 * `replace_whole` fixture: the whole body (after the BOM) is replaced while the
 * BOM itself must be preserved; the original body mixes CRLF/LF/CJK.
 */
export const WHOLE_FIXTURE: ReplaceWholeFixture = {
  path: "Corpus/Edits/Whole.md",
  originalText:
    "﻿" +
    "# Nota completa\r\n" +
    "\r\n" +
    "Este contenido será reemplazado entero.\n" +
    "Conserva 你好 与 🎉.\r\n",
  replacementText:
    "# Nota reemplazada\r\n" +
    "\r\n" +
    "Todo el cuerpo cambió.\n" +
    "🚀 nuevo final sin salto",
};

export const WHOLE_ORIGINAL_BYTES: Uint8Array = encode(WHOLE_FIXTURE.originalText);
export const WHOLE_COMMITTED_TEXT: string =
  "﻿" + WHOLE_FIXTURE.replacementText;
export const WHOLE_COMMITTED_BYTES: Uint8Array = encode(WHOLE_COMMITTED_TEXT);

/**
 * Typed-Frontmatter fixture: an untouched CRLF Frontmatter block with JSON
 * scalar values and a CRLF/CJK body below. The rewrite sets one key, removes
 * one key, and appends one key; the body bytes are never touched.
 */
export const FRONTMATTER_FIXTURE: FrontmatterFixture = {
  path: "Corpus/Frontmatter/Typed.md",
  originalText:
    "---\r\n" +
    "title: \"Mi Nota\"\r\n" +
    "status: draft\r\n" +
    "count: 1\r\n" +
    "---\r\n" +
    "\r\n" +
    "# Cuerpo\r\n" +
    "\r\n" +
    "Texto intacto con 你好 y 🚀\r\n",
  changes: [
    { kind: "set", key: "status", value: "published" },
    { kind: "remove", key: "count" },
    { kind: "set", key: "reviewer", value: "你好" },
  ],
};

export const FRONTMATTER_ORIGINAL_BYTES: Uint8Array = encode(
  FRONTMATTER_FIXTURE.originalText,
);

const projectedFrontmatter = projectFrontmatter(
  FRONTMATTER_ORIGINAL_BYTES,
  [...FRONTMATTER_FIXTURE.changes],
);
if (projectedFrontmatter === null) {
  throw new Error("Frontmatter corpus fixture did not project");
}
export const FRONTMATTER_COMMITTED_BYTES: Uint8Array = Uint8Array.from(projectedFrontmatter);
