import { describe, expect, it } from "vitest";

import { createRegistrationCommand } from "../src/registration-command.js";

describe("Claude Code MCP registration command", () => {
  it("generates but does not execute a local HTTP registration with the expected Vault ID", () => {
    expect(createRegistrationCommand("vault-a", 27123, "alpha")).toBe(
      "claude mcp add --transport http --scope local --header 'X-Expected-Vault-ID: vault-a' alpha 'http://127.0.0.1:27123/mcp'",
    );
  });

  it("quotes PowerShell header values and rejects invalid server names", () => {
    expect(createRegistrationCommand("vault'quoted", 27123, "alpha")).toContain(
      "--header 'X-Expected-Vault-ID: vault''quoted'",
    );
    expect(() => createRegistrationCommand("vault-a", 27123, "alpha vault")).toThrow(
      "unsupported characters",
    );
  });
});
