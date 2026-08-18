const MAX_REDACTED_LENGTH = 20_000;

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
