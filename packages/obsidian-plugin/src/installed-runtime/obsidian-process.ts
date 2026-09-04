import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Obsidian process-control seam (issue #197): the orchestrator only knows
 * `start`/`stop`. The real Windows implementation below launches the
 * registered Obsidian executable against the dedicated test Vault and
 * profile; inner tests substitute a fake that hosts a real Bridge Instance.
 */

export interface ObsidianLaunchRequest {
  readonly vaultPath: string;
  readonly profileDirectory: string;
}

export interface ObsidianProcessHandle {
  readonly pid: number | undefined;
  /** Resolves only after the process tree has fully exited. */
  stop(): Promise<void>;
}

export interface ObsidianProcessControl {
  start(request: ObsidianLaunchRequest): Promise<ObsidianProcessHandle>;
}

export class ObsidianProcessError extends Error {
  constructor(
    message: string,
    readonly code: "obsidian_start_failed" | "obsidian_stop_failed",
  ) {
    super(message);
    this.name = "ObsidianProcessError";
  }
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ObsidianProcessError("Obsidian did not exit within the stop deadline", "obsidian_stop_failed"));
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Real process control for the registered Windows runtime. The dedicated
 * profile directory is passed through Electron's `--user-data-dir` switch so
 * the run never touches the Primary Operator's own Obsidian configuration;
 * the Vault path argument opens exactly the generated test Vault. Stop uses
 * `taskkill /T` on Windows so the whole Electron process tree exits.
 */
export function createWindowsObsidianProcessControl(options: {
  executablePath: string;
  stopTimeoutMs?: number;
  spawnImpl?: typeof spawn;
}): ObsidianProcessControl {
  const spawnImpl = options.spawnImpl ?? spawn;
  const stopTimeoutMs = options.stopTimeoutMs ?? 30_000;
  return {
    async start(request) {
      let child: ChildProcess;
      try {
        child = spawnImpl(
          options.executablePath,
          [
            `--user-data-dir=${request.profileDirectory}`,
            `obsidian://open?path=${encodeURIComponent(request.vaultPath)}`,
          ],
          { stdio: "ignore", windowsHide: true },
        );
      } catch (error) {
        throw new ObsidianProcessError(
          `Obsidian failed to launch: ${error instanceof Error ? error.message : String(error)}`,
          "obsidian_start_failed",
        );
      }
      const spawnError = await new Promise<Error | null>((resolve) => {
        child.once("error", resolve);
        child.once("spawn", () => resolve(null));
      });
      if (spawnError !== null) {
        throw new ObsidianProcessError(
          `Obsidian failed to launch: ${spawnError.message}`,
          "obsidian_start_failed",
        );
      }
      let stopped = false;
      return {
        pid: child.pid,
        async stop() {
          if (stopped) return;
          stopped = true;
          if (child.exitCode !== null || child.signalCode !== null) return;
          try {
            if (process.platform === "win32") {
              await new Promise<void>((resolve, reject) => {
                const killer = spawnImpl(
                  "taskkill",
                  ["/PID", String(child.pid), "/T", "/F"],
                  { stdio: "ignore", windowsHide: true },
                );
                killer.once("error", reject);
                killer.once("exit", (code) =>
                  code === 0 || code === 128
                    ? resolve()
                    : reject(new Error(`taskkill exited with code ${code ?? "unknown"}`)),
                );
              });
            } else {
              child.kill("SIGTERM");
            }
            await waitForExit(child, stopTimeoutMs);
          } catch (error) {
            try {
              child.kill("SIGKILL");
            } catch {
              // The process may have exited between the failed stop and now.
            }
            if (child.exitCode === null && child.signalCode === null) {
              throw new ObsidianProcessError(
                `Obsidian did not stop cleanly: ${error instanceof Error ? error.message : String(error)}`,
                "obsidian_stop_failed",
              );
            }
          }
        },
      };
    },
  };
}

/**
 * The Bridge identity persisted by the loaded candidate plugin
 * (`.obsidian/plugins/<id>/data.json`). Absent file means the plugin has not
 * initialized yet; a present but structurally invalid file is a candidate
 * failure, not a "keep waiting" signal.
 */
export interface PersistedBridgeIdentity {
  readonly vaultId: string;
  readonly port: number;
}

export class BridgeIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeIdentityError";
  }
}

export async function readPersistedBridgeIdentity(
  vaultPath: string,
  pluginId: string,
  configDirectoryName = ".obsidian",
): Promise<PersistedBridgeIdentity | null> {
  let raw: string;
  try {
    raw = await readFile(
      join(vaultPath, configDirectoryName, "plugins", pluginId, "data.json"),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BridgeIdentityError("Persisted Bridge settings are not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BridgeIdentityError("Persisted Bridge settings are not an object");
  }
  const { vaultId, port } = parsed as Record<string, unknown>;
  if (
    typeof vaultId !== "string" ||
    vaultId.length === 0 ||
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new BridgeIdentityError("Persisted Bridge settings lack a valid Vault identity");
  }
  return { vaultId, port };
}

export interface ReadinessWaitOptions {
  readonly timeoutMs: number;
  readonly intervalMs?: number;
}

export class ReadinessTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadinessTimeoutError";
  }
}

/** Polls one condition until it holds or the deadline expires (fail closed). */
export async function waitForCondition(
  check: () => Promise<boolean>,
  options: ReadinessWaitOptions,
): Promise<void> {
  const intervalMs = options.intervalMs ?? 250;
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) {
      throw new ReadinessTimeoutError("Bridge Instance readiness deadline expired");
    }
    await delay(intervalMs);
  }
}
