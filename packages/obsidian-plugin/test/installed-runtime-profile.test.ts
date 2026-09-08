import { describe, expect, it } from "vitest";

import {
  hostOsBuild,
  lookupRegisteredRuntimeProfile,
  MVP_PERF_REF_1,
  preflightRuntimeProfile,
  registeredRuntimeProfiles,
  type ObservedRuntimeEnvironment,
} from "../src/index.js";

const MATCHING_OBSERVED: ObservedRuntimeEnvironment = {
  platform: "win32",
  osBuild: "26200",
  obsidianVersion: "1.13.4",
  electronVersion: "39.6.0",
  nodeVersion: "24.14.0",
  capabilities: ["loopback_http", "ntfs_fixtures", "obsidian_gui", "process_control"],
};

describe("registered runtime profiles", () => {
  it("registers MVP-PERF-REF-1 exactly as specified", () => {
    expect(MVP_PERF_REF_1).toMatchObject({
      name: "MVP-PERF-REF-1",
      os: { platform: "win32", build: "26200" },
      versions: { obsidian: "1.13.4", electron: "39.6.0", node: "24.14.0" },
      profileRequirement: "dedicated_candidate_only",
    });
    expect(lookupRegisteredRuntimeProfile("MVP-PERF-REF-1")).toBe(MVP_PERF_REF_1);
    expect(registeredRuntimeProfiles().get("MVP-PERF-REF-1")).toBe(MVP_PERF_REF_1);
  });

  it("fails closed for unregistered profile names", () => {
    expect(lookupRegisteredRuntimeProfile("MVP-PERF-REF-2")).toBeNull();
    expect(lookupRegisteredRuntimeProfile("")).toBeNull();
  });
});

describe("runtime profile preflight", () => {
  it("passes only when every registered fact matches the probed host", () => {
    expect(preflightRuntimeProfile(MVP_PERF_REF_1, MATCHING_OBSERVED)).toEqual([]);
  });

  it("reports each mismatching dimension", () => {
    const mismatches = preflightRuntimeProfile(MVP_PERF_REF_1, {
      ...MATCHING_OBSERVED,
      platform: "linux",
      osBuild: "26100",
      obsidianVersion: "1.12.0",
      electronVersion: "38.0.0",
      nodeVersion: "22.0.0",
    });
    expect(mismatches).toEqual([
      { field: "os.platform", expected: "win32", actual: "linux" },
      { field: "os.build", expected: "26200", actual: "26100" },
      { field: "versions.obsidian", expected: "1.13.4", actual: "1.12.0" },
      { field: "versions.electron", expected: "39.6.0", actual: "38.0.0" },
      { field: "versions.node", expected: "24.14.0", actual: "22.0.0" },
    ]);
  });

  it("treats unverifiable facts as mismatches rather than matches", () => {
    const mismatches = preflightRuntimeProfile(MVP_PERF_REF_1, {
      platform: "win32",
      capabilities: MATCHING_OBSERVED.capabilities,
    });
    expect(mismatches).toEqual([
      { field: "os.build", expected: "26200", actual: null },
      { field: "versions.obsidian", expected: "1.13.4", actual: null },
      { field: "versions.electron", expected: "39.6.0", actual: null },
      { field: "versions.node", expected: "24.14.0", actual: null },
    ]);
  });

  it("reports missing capabilities", () => {
    const mismatches = preflightRuntimeProfile(MVP_PERF_REF_1, {
      ...MATCHING_OBSERVED,
      capabilities: ["loopback_http"],
    });
    expect(mismatches).toEqual([
      {
        field: "capabilities",
        expected: "loopback_http,ntfs_fixtures,obsidian_gui,process_control",
        actual: "loopback_http",
      },
    ]);
  });

  it("derives the Windows build only from win32 release strings", () => {
    expect(hostOsBuild("win32", "10.0.26200")).toBe("26200");
    expect(hostOsBuild("win32", "10.0")).toBeUndefined();
    expect(hostOsBuild("linux", "6.6.87.2-microsoft-standard-WSL2")).toBeUndefined();
  });
});
