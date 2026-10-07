import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Read-only linkage between an authenticated callback PID and its supervised
 * Obsidian launcher. A matching report PID alone is not process provenance. */
export async function requireObserverInSupervisedProcessTree(observerPid: number, supervisorPid: number): Promise<void> {
  if (![observerPid, supervisorPid].every(pid => Number.isInteger(pid) && pid > 0)) throw new Error("Observer process provenance is missing");
  let pid = observerPid;
  const visited = new Set<number>();
  for (let depth = 0; depth < 32 && pid > 0 && !visited.has(pid); depth++) {
    if (pid === supervisorPid) return;
    visited.add(pid);
    if (process.platform === "linux") {
      const facts = await readFile(`/proc/${pid}/stat`, "utf8");
      const closing = facts.lastIndexOf(")");
      if (closing < 0) throw new Error("Observer process ancestry unavailable");
      pid = Number(facts.slice(closing + 2).split(" ")[1]);
    } else if (process.platform === "win32") {
      const result = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').ParentProcessId`], { timeout: 5_000, windowsHide: true });
      const parent = result.stdout.trim();
      if (!/^\d+$/u.test(parent)) throw new Error("Observer process ancestry unavailable");
      pid = Number(parent);
    } else throw new Error("Observer process provenance is unsupported on this platform");
  }
  throw new Error("Observer renderer is not in the supervised Obsidian process tree");
}
