# PROTOTYPE — installed Streamable HTTP transport probe

This throwaway prototype asks what conservative Exact Read and transport limits, grouping default, and continuation lifetime should be selected for the installed Obsidian 1.x / Claude Code 2.1.220 path. It is not the Vault Operation Bridge and implements no product semantics. The plugin binds only `127.0.0.1:27124`, exposes deterministic read-only probe tools, records request/response observations in its own plugin directory, and never reads note content or mutates the Vault.

## Why two paths are measured

The official Claude Code MCP documentation describes context-management limits, not an HTTP response-body byte ceiling:

- warning above 10,000 MCP-output tokens;
- default maximum of 25,000 MCP-output tokens, configurable with `MAX_MCP_OUTPUT_TOKENS`;
- oversized unannotated text results are persisted to disk and replaced in the conversation by a file reference;
- `_meta.anthropic/maxResultSizeChars` raises one tool's in-context character threshold, with a hard ceiling of 500,000 characters;
- pagination is a server responsibility; no client transport-level automatic pagination or grouping is documented.

`probe_payload` carries the maximum 500,000-character annotation so the measured path distinguishes raw transport reception from the normal lower context-management threshold. A second run can remove that line to observe default offloading behavior.

Official source: <https://code.claude.com/docs/en/mcp#mcp-output-limits-and-warnings>

## Install and run

From the repository root in PowerShell:

```powershell
./.scratch/reliable-vault-operations/prototypes/installed-transport-probe/install.ps1
```

The script copies this directory to the ThinkFlywheel Vault's plugin directory, refreshes the manifest cache, and loads it only in the current Obsidian process through the official Obsidian CLI. It does not add the probe to Obsidian's persistent enabled-plugin set. It also writes a temporary MCP config under the current job's temp directory and prints the exact `claude -p --strict-mcp-config` command to run.

The MCP endpoint is:

```text
http://127.0.0.1:27124/mcp
```

Use `probe_state` first to capture installed Obsidian, Electron, Node, note count, and aggregate size without returning note content.

For a payload test, instruct Claude to call `probe_payload` exactly once with one byte count and report only these fields: `requested_bytes`, `payload_bytes`, `sha256`, whether the `BEGIN:<n>` marker is present, whether the `END:<n>` marker is present, and whether it received a file reference instead of inline content. Run separate Claude processes for each size to prevent prior results from consuming context.

Suggested bracket, stopping as soon as offloading or model-visible loss occurs:

```text
64 KiB, 128 KiB, 256 KiB, 384 KiB, 480 KiB, 512 KiB, 1 MiB
```

The 500,000-character annotation means 480 KiB is the highest useful inline-text bracket. Larger responses still test HTTP reception and offloading but should not be selected as the normal transport ceiling.

## Timeout probes

Claude Code 2.1.220 supports these documented controls:

- per-server `timeout` in milliseconds: hard wall-clock timeout per call;
- `MCP_TOOL_TIMEOUT`: global hard wall-clock fallback;
- HTTP first-byte timer: 60 seconds unless a configured timeout of at least 60 seconds raises it;
- `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`: idle timeout, default five minutes for HTTP; progress notifications prevent idle timeout but not wall-clock timeout;
- `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`: main-conversation calls move to background after two minutes; noninteractive mode requires `CLAUDE_AUTO_BACKGROUND_TASKS=1`.

Official source: <https://code.claude.com/docs/en/mcp#automatic-reconnection>

Use `delay_ms` to test below and above explicit short timeouts. Do not wait for undocumented defaults: set per-server `timeout` in the temporary config so the acceptance behavior is deterministic.

## Evidence

The installed copy writes `probe-observations.jsonl` beside `main.js`. Each tool request records its method/arguments; each response records the compact JSON byte count. Compare this server-side evidence with the Claude Code debug log and model-visible marker report.

No response-size trial proves a universal client hard ceiling. The selected production values are conservative operating constants bounded by the documented 500,000-character context-management ceiling, the observed Vault corpus, latency targets, and continuation retention pressure.

## Cleanup

```powershell
./.scratch/reliable-vault-operations/prototypes/installed-transport-probe/uninstall.ps1
```

The cleanup script unloads the current-process probe and verifies that it is not persistently enabled. It intentionally does not delete the Vault-external static plugin directory; after reviewing `probe-observations.jsonl`, remove the manifest-verified `C:\Obsidian\ThinkFlywheelVault\.obsidian\plugins\vault-transport-probe` directory manually.
