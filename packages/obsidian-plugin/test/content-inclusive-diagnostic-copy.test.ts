import { describe, expect, it, vi } from "vitest";

import {
  CONTENT_INCLUSIVE_DIAGNOSTIC_PURPOSE,
  type ContentInclusiveDiagnosticBundle,
} from "../src/content-inclusive-diagnostic-bundle.js";
import {
  hasContentInclusiveSelection,
  performContentInclusiveDiagnosticCopy,
} from "../src/content-inclusive-diagnostic-copy.js";

describe("content-inclusive diagnostic copy flow", () => {
  it("treats only a non-empty selection as explicit content", () => {
    expect(hasContentInclusiveSelection("")).toBe(false);
    expect(hasContentInclusiveSelection("   ")).toBe(true);
    expect(hasContentInclusiveSelection("selected")).toBe(true);
  });

  it("produces and copies nothing when no content is selected", async () => {
    const confirm = vi.fn(async () => true);
    const generate = vi.fn(async () => {
      throw new Error("must not generate without a selection");
    });
    const write = vi.fn(async () => undefined);
    const outcome = await performContentInclusiveDiagnosticCopy({
      selection: "",
      confirm,
      generate,
      write,
    });
    expect(outcome).toEqual({ outcome: "not_available" });
    expect(confirm).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("produces and copies nothing when the confirmation is cancelled", async () => {
    const confirm = vi.fn(async () => false);
    const generate = vi.fn(async () => {
      throw new Error("must not generate on cancel");
    });
    const write = vi.fn(async () => undefined);
    const outcome = await performContentInclusiveDiagnosticCopy({
      selection: "selected",
      confirm,
      generate,
      write,
    });
    expect(outcome).toEqual({ outcome: "cancelled" });
    expect(generate).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("produces and copies nothing when the confirmation is rejected", async () => {
    const confirm = vi.fn(() => Promise.reject(new Error("operator rejected")));
    const generate = vi.fn(async () => {
      throw new Error("must not generate on reject");
    });
    const write = vi.fn(async () => undefined);
    await expect(
      performContentInclusiveDiagnosticCopy({
        selection: "selected",
        confirm,
        generate,
        write,
      }),
    ).rejects.toThrow("operator rejected");
    expect(generate).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("copies the serialized bundle only after a fresh confirmation", async () => {
    const selected = "exactly selected content";
    const bundle: ContentInclusiveDiagnosticBundle = {
      schemaVersion: 1,
      bundleVersion: "1.0",
      purpose: CONTENT_INCLUSIVE_DIAGNOSTIC_PURPOSE,
      trace: {
        source: "managed_vault_bridge",
        versions: {
          bridge: "0.1.0",
          plugin: "0.1.0",
          protocol: "1.0",
          persistentStateSchema: 2,
          recoveryJournalSchema: 3,
        },
      },
      selection: { tracer: "active_editor_selection", content: selected },
      checksum: {
        algorithm: "sha256",
        canonicalPayload: `sha256:${"a".repeat(64)}`,
      },
    };
    const confirm = vi.fn(async () => true);
    const generate = vi.fn(async (selection: string) => {
      expect(selection).toBe(selected);
      return bundle;
    });
    const write = vi.fn(async () => undefined);

    const outcome = await performContentInclusiveDiagnosticCopy({
      selection: selected,
      confirm,
      generate,
      write,
    });
    expect(outcome).toEqual({ outcome: "copied" });
    expect(confirm).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledWith(selected);
    expect(write).toHaveBeenCalledOnce();
    expect(JSON.parse(write.mock.calls[0]![0] as string)).toMatchObject({
      purpose: CONTENT_INCLUSIVE_DIAGNOSTIC_PURPOSE,
      selection: { tracer: "active_editor_selection", content: selected },
    });
  });
});
