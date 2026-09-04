import { platform, release } from "node:os";

/**
 * Installed-runtime profiles (spec §12.1): a candidate bundle may only
 * register passing lifecycle evidence on a specifically registered
 * Windows/Obsidian runtime. The registry is closed; an unknown profile name or
 * any mismatch between the registered expectation and the probed host fails
 * closed and can never produce passing evidence.
 */

export interface RuntimeVersionExpectation {
  readonly obsidian: string;
  readonly electron: string;
  readonly node: string;
}

export interface RegisteredRuntimeProfile {
  readonly name: string;
  readonly os: {
    readonly platform: string;
    /** Windows build number, e.g. "26200" for the MVP reference machine. */
    readonly build: string;
  };
  readonly versions: RuntimeVersionExpectation;
  /** Capabilities the host must prove before evidence can be registered. */
  readonly capabilities: readonly string[];
  /**
   * The registered profile requires a dedicated Obsidian profile in which the
   * candidate Vault Operation Bridge is the only enabled community plugin.
   */
  readonly profileRequirement: "dedicated_candidate_only";
}

export const MVP_PERF_REF_1: RegisteredRuntimeProfile = Object.freeze({
  name: "MVP-PERF-REF-1",
  os: { platform: "win32", build: "26200" },
  versions: { obsidian: "1.13.4", electron: "39.6.0", node: "24.14.0" },
  capabilities: ["loopback_http", "ntfs_fixtures", "obsidian_gui", "process_control"],
  profileRequirement: "dedicated_candidate_only",
});

const REGISTERED_PROFILES: ReadonlyMap<string, RegisteredRuntimeProfile> = new Map(
  [MVP_PERF_REF_1].map((profile) => [profile.name, profile]),
);

export function registeredRuntimeProfiles(): ReadonlyMap<string, RegisteredRuntimeProfile> {
  return REGISTERED_PROFILES;
}

export function lookupRegisteredRuntimeProfile(
  name: string,
): RegisteredRuntimeProfile | null {
  return REGISTERED_PROFILES.get(name) ?? null;
}

/**
 * Facts observed on the host under test. A fact that cannot be verified is
 * absent (`undefined`) and fails closed as a mismatch — unverifiable is never
 * treated as matching.
 */
export interface ObservedRuntimeEnvironment {
  readonly platform: string;
  /** Operating-system build, e.g. the Windows build from `os.release()`. */
  readonly osBuild?: string;
  readonly obsidianVersion?: string;
  readonly electronVersion?: string;
  readonly nodeVersion?: string;
  readonly capabilities: readonly string[];
}

export interface RuntimeEnvironmentProbe {
  probe(): Promise<ObservedRuntimeEnvironment>;
}

export interface RuntimePreflightMismatch {
  readonly field:
    | "os.platform"
    | "os.build"
    | "versions.obsidian"
    | "versions.electron"
    | "versions.node"
    | "capabilities";
  readonly expected: string;
  readonly actual: string | null;
}

/**
 * Compares one registered profile against probed host facts. The result is the
 * complete ordered mismatch list; an empty list is the only passing outcome.
 */
export function preflightRuntimeProfile(
  profile: RegisteredRuntimeProfile,
  observed: ObservedRuntimeEnvironment,
): RuntimePreflightMismatch[] {
  const mismatches: RuntimePreflightMismatch[] = [];
  const compare = (
    field: RuntimePreflightMismatch["field"],
    expected: string,
    actual: string | undefined,
  ): void => {
    if (actual !== expected) {
      mismatches.push({ field, expected, actual: actual ?? null });
    }
  };
  compare("os.platform", profile.os.platform, observed.platform);
  compare("os.build", profile.os.build, observed.osBuild);
  compare("versions.obsidian", profile.versions.obsidian, observed.obsidianVersion);
  compare("versions.electron", profile.versions.electron, observed.electronVersion);
  compare("versions.node", profile.versions.node, observed.nodeVersion);
  const missing = profile.capabilities.filter(
    (capability) => !observed.capabilities.includes(capability),
  );
  if (missing.length > 0) {
    mismatches.push({
      field: "capabilities",
      expected: profile.capabilities.join(","),
      actual: observed.capabilities.join(","),
    });
  }
  return mismatches;
}

/**
 * Derives the Windows build number from `os.release()` (`10.0.26200` →
 * `26200`). Any other platform or an unparseable release yields no build,
 * which preflight treats as a mismatch against a registered Windows profile.
 */
export function hostOsBuild(platformName = platform(), osRelease = release()): string | undefined {
  if (platformName !== "win32") return undefined;
  const parts = osRelease.split(".");
  const build = parts[2];
  return build !== undefined && /^\d+$/u.test(build) ? build : undefined;
}
