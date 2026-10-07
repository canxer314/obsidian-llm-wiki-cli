import { createHash, createHmac } from "node:crypto";
import { z } from "zod";

export const EVENT_OBSERVER_ID = "llm-wiki-event-observer";
export const EVENT_OBSERVER_LISTENERS = ["create", "modify", "rename", "delete", "changed", "resolved"] as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const pluginEventObserverBindingSchema = z.object({
  runId: z.string().min(1), vaultPath: z.string().min(1), vaultId: z.string().nullable(),
  candidateBundleSha256: digest, installedMainSha256: digest, profileName: z.string().min(1),
  observerMainSha256: digest, generation: z.number().int().positive(), capabilityToken: digest,
}).strict();
export type PluginEventObserverBinding = z.infer<typeof pluginEventObserverBindingSchema>;
const payloadSchema = pluginEventObserverBindingSchema.omit({ capabilityToken: true }).extend({
  pid: z.number().int().positive(), sequence: z.number().int().positive(), at: z.number().int().nonnegative(),
  kind: z.enum(["ready", "candidate-start", "window-begin", "window-end", "heartbeat", "stopped", "failure", "snapshot", ...EVENT_OBSERVER_LISTENERS]),
  listeners: z.array(z.string()).optional(), enabledPlugins: z.array(z.string()).optional(),
  path: z.string().optional(), oldPath: z.string().optional(), presence: z.enum(["file", "absent", "directory"]).optional(),
  rawBytesBase64: z.string().optional(),
}).strict();
const eventSchema = z.object({ payload: payloadSchema, mac: digest }).strict();

/** Public report boundary. Raw bytes remain private; the returned evidence is hashes/counts only. */
export function verifyPluginEventObserverWindow(options: {
  binding: PluginEventObserverBinding; events: unknown; candidatePluginId: string; expectedPid: number;
  requiredVisibleStates?: readonly { path: string; bytes: Uint8Array }[];
  requiredTransition?: { path: string; states: readonly Uint8Array[] };
  /** Fixed crash runner's reached actions; default correctness corpus still requires every changed target. */
  requiredCallbackPaths?: readonly string[];
  files: readonly { path: string; before: Uint8Array | null; after: Uint8Array | null; allowFixtureLifecycleAbsence?: boolean }[]; maxSilenceMs: number;
}) {
  const events = z.array(eventSchema).min(4).parse(options.events);
  const files = new Map(options.files.map(file => [file.path, file]));
  let ready = false, started = false, active = false, ended = false, previousAt = 0;
  let eventCount = 0, indexingCount = 0;
  const observations: { sequence: number; kind: string; pathSha256: string; bytesSha256: string | null; sizeBytes: number }[] = [];
  const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
  const plugins = [EVENT_OBSERVER_ID, options.candidatePluginId].sort();
  for (const [index, event] of events.entries()) {
    const p = event.payload;
    const rawPayload = (options.events as { payload: unknown }[])[index]!.payload;
    if (event.mac !== createHmac("sha256", options.binding.capabilityToken).update(JSON.stringify(rawPayload)).digest("hex")) throw new Error("Observer report authentication failed");
    for (const key of ["runId", "vaultPath", "candidateBundleSha256", "installedMainSha256", "profileName", "observerMainSha256", "generation"] as const) {
      if (p[key] !== options.binding[key]) throw new Error("Observer report identity binding changed");
    }
    if (p.pid !== options.expectedPid || p.sequence !== index + 1 || p.at < previousAt) throw new Error("Observer process/sequence order changed");
    if (active && p.at - previousAt > options.maxSilenceMs) throw new Error("Observer failed during observation window");
    previousAt = p.at;
    if (active && p.vaultId !== options.binding.vaultId) throw new Error("Observer event Managed Vault binding changed");
    if (p.kind === "failure" || p.kind === "stopped" && !ended) throw new Error("Observer failed during observation window");
    if ((EVENT_OBSERVER_LISTENERS as readonly string[]).includes(p.kind) && p.path === undefined) throw new Error("Observer callback lacks event-time path and raw bytes");
    if (ended && p.kind !== "window-end") throw new Error("Observer report continues after sealed window");
    if (p.kind === "ready") {
      if (ready || index !== 0 || JSON.stringify(p.listeners) !== JSON.stringify(EVENT_OBSERVER_LISTENERS) || JSON.stringify(p.enabledPlugins?.slice().sort()) !== JSON.stringify(plugins)) throw new Error("Observer was not ready with all callbacks and enabled plugins");
      ready = true;
    } else if (p.kind === "candidate-start") {
      if (!ready || started || active) throw new Error("Observer was not ready before candidate startup recovery");
      started = true;
    } else if (p.kind === "window-begin") {
      if (!started || active || ended || p.vaultId !== options.binding.vaultId) throw new Error("Observer window was not started with Managed Vault identity");
      active = true;
    } else if (p.kind === "window-end") {
      if (!active || ended || p.vaultId !== options.binding.vaultId) throw new Error("Observer window end is unbound");
      active = false; ended = true;
    } else if (p.path !== undefined) {
      // Include startup callbacks too: a recovery event before the explicit mutation window cannot be ignored.
      if (!ready || ended) throw new Error("Observer event outside registered observation window");
      if (!(EVENT_OBSERVER_LISTENERS as readonly string[]).includes(p.kind) && p.kind !== "snapshot") throw new Error("Observer file bytes were not captured by a real callback");
      const fixture = files.get(p.path);
      const parentDirectory = p.presence === "directory" && [...files.keys()].some(path => path.startsWith(`${p.path}/`));
      if ((fixture === undefined && !parentDirectory) || p.path.split("/").some(part => part.startsWith(".") || /staging|\.next$|\.tmp$/iu.test(part))) throw new Error("Observer saw staging or an undeclared visible path");
      if (p.presence === "file") {
        if (p.rawBytesBase64 === undefined) throw new Error("Observer event is missing raw bytes");
        const bytes = Buffer.from(p.rawBytesBase64, "base64");
        if (bytes.toString("base64") !== p.rawBytesBase64 || ![fixture!.before, fixture!.after].some(allowed => allowed !== null && bytes.equals(allowed))) throw new Error("Observer did not see complete before/after bytes");
        observations.push({ sequence: p.sequence, kind: p.kind, pathSha256: hash(p.path), bytesSha256: hash(bytes), sizeBytes: bytes.length });
      } else if (p.presence === "absent" && (fixture!.before === null || fixture!.after === null || fixture!.allowFixtureLifecycleAbsence === true)) {
        observations.push({ sequence: p.sequence, kind: p.kind, pathSha256: hash(p.path), bytesSha256: null, sizeBytes: 0 });
      } else if (p.presence === "directory" && [...files.keys()].some(path => path.startsWith(`${p.path}/`))) {
        // Folder callbacks carry no file bytes; known fixture parents are the only allowed directories.
      } else throw new Error("Observer event has an unallowed absence or incomplete bytes");
      if (p.presence !== "directory" && p.kind !== "snapshot") eventCount++;
      if (p.presence !== "directory" && (p.kind === "changed" || p.kind === "resolved")) indexingCount++;
      if (p.oldPath !== undefined && !files.has(p.oldPath)) throw new Error("Observer saw undeclared rename source");
    }
  }
  if (options.requiredTransition !== undefined) {
    let next = 0;
    const transition = options.requiredTransition;
    for (const observation of observations) {
      if (next < transition.states.length && observation.pathSha256 === hash(transition.path) &&
          observation.bytesSha256 === hash(transition.states[next]!) && (EVENT_OBSERVER_LISTENERS as readonly string[]).includes(observation.kind)) next++;
    }
    if (next !== transition.states.length) throw new Error("Observer lacks ordered complete state transition callbacks");
  }
  for (const required of options.requiredVisibleStates ?? []) {
    if (!observations.some(observation => observation.pathSha256 === hash(required.path) && observation.bytesSha256 === hash(required.bytes) && (EVENT_OBSERVER_LISTENERS as readonly string[]).includes(observation.kind))) throw new Error("Observer required visible state lacks event-time bytes");
  }
  const changedTargets = options.requiredCallbackPaths === undefined ? options.files.filter(file => file.before === null || file.after === null || !Buffer.from(file.before).equals(file.after)) : options.requiredCallbackPaths.map(path => {
    const file = files.get(path);
    if (file === undefined) throw new Error("Observer required callback path is undeclared");
    return file;
  });
  for (const target of changedTargets) {
    if (!observations.some(observation => observation.pathSha256 === hash(target.path) && ["create", "modify", "rename", "delete"].includes(observation.kind))) throw new Error("Observer target lacks real Vault callback bytes");
    if (!observations.some(observation => observation.pathSha256 === hash(target.path) && (observation.kind === "changed" || observation.kind === "resolved"))) throw new Error("Observer target lacks real indexing callback bytes");
  }
  if (!ready || !started || !ended || active || changedTargets.length > 0 && (eventCount === 0 || indexingCount === 0)) throw new Error("Observer window lacks live event/indexing coverage");
  return { observerId: EVENT_OBSERVER_ID, observerMainSha256: options.binding.observerMainSha256,
    generation: options.binding.generation, pid: options.expectedPid, eventCount, indexingCount, enabledPlugins: plugins,
    readyBeforeCandidateStartup: true as const, callbacksRegisteredInCandidateProcess: true as const,
    observationWindow: { firstSequence: 1, lastSequence: events.length, startedAt: events[0]!.payload.at, endedAt: previousAt },
    protocolOrder: events.filter(event => ["ready", "candidate-start", "window-begin", "window-end"].includes(event.payload.kind)).map(event => ({ kind: event.payload.kind, sequence: event.payload.sequence, at: event.payload.at })),
    observations, transcriptSha256: hash(JSON.stringify(events)), verdict: "passed" as const };
}
