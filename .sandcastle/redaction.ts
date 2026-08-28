const MAX_REDACTED_LENGTH = 20_000;
const MAX_DIAGNOSTIC_SUMMARY_LENGTH = 500;

export function diagnosticSummary(text: string): string {
  const firstLine = text.split(/\r?\n/u, 1)[0] ?? "";
  return redact(firstLine)
    .replace(/(^|[\s(=])\/(?:[^\s/]+\/)*[^\s,;)]*/gu, "$1[LOCAL_PATH]")
    .replace(/(?:\[REDACTED\]\s*){2,}/gu, "[REDACTED] ")
    .replace(/\s+(?=[,;])/gu, "")
    .trim()
    .slice(0, MAX_DIAGNOSTIC_SUMMARY_LENGTH);
}

export function redact(text: string): string {
  return text
    .replace(
      /(authorization\s*[:=]\s*bearer\s+)([^\s,;]+)/giu,
      "$1[REDACTED]",
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/gu,
      "[REDACTED]",
    )
    .replace(
      /((?:"?(?:token|password|secret|api[_-]?key|authorization)"?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu,
      "$1[REDACTED]",
    )
    .slice(0, MAX_REDACTED_LENGTH);
}
