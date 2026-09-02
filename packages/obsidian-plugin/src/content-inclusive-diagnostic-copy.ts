/**
 * Local Primary Operator copy flow for content-inclusive diagnostics
 * (spec §9.4; Spec #41 / #167).
 *
 * The flow is deliberately Obsidian-free so the availability gate and the
 * confirm/cancel/no-output contract can be unit-tested without a plugin host.
 * The Obsidian command in main.ts supplies the active-editor selection, a
 * fresh interactive confirmation prompt, the runtime producer, and the
 * clipboard writer.
 *
 * Contract: with no explicitly selected content the flow produces nothing; a
 * cancelled or rejected confirmation produces and copies nothing; only a
 * confirmed generation copies the serialized content-inclusive bundle.
 */

/** The smallest accepted tracer is a non-empty active-editor selection. */
export function hasContentInclusiveSelection(selection: string): boolean {
  return selection.length > 0;
}

export type ContentInclusiveDiagnosticCopyOutcome =
  | { readonly outcome: "not_available" }
  | { readonly outcome: "cancelled" }
  | { readonly outcome: "copied" };

export interface ContentInclusiveDiagnosticCopyTargets {
  /** The active editor's current selection; must be non-empty to proceed. */
  readonly selection: string;
  /** Fresh interactive Primary Operator confirmation for this generation. */
  confirm(): boolean | Promise<boolean>;
  /** Generates one content-inclusive diagnostic bundle for the selection. */
  generate(selection: string): unknown | Promise<unknown>;
  /** Writes the serialized bundle to the local clipboard. */
  write(text: string): void | Promise<void>;
}

export async function performContentInclusiveDiagnosticCopy(
  targets: ContentInclusiveDiagnosticCopyTargets,
): Promise<ContentInclusiveDiagnosticCopyOutcome> {
  if (!hasContentInclusiveSelection(targets.selection)) {
    return { outcome: "not_available" };
  }
  const confirmed = await targets.confirm();
  if (!confirmed) return { outcome: "cancelled" };
  const bundle = await targets.generate(targets.selection);
  await targets.write(JSON.stringify(bundle));
  return { outcome: "copied" };
}
