import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  RELEASE_PLUGIN_ID,
  RELEASE_REPOSITORY,
  RELEASE_WORKFLOW_PATH,
  assembleReleaseBundle,
  claimsFromGhAttestationVerifyOutput,
  installCandidateBundle,
  parseReleaseTag,
  provisionTestVault,
  verifyReleaseBundle,
  type ReleaseAttestationClaims,
  type VerifiedReleaseBundle,
} from "../src/index.js";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

const TAG = "v0.3.0";
const VERSION = "0.3.0";
const MIN_APP_VERSION = "1.13.4";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "release-bundle-"));
}

/** Builds a fake plugin package root pinned to the release identity constants. */
async function writePackageRoot(
  root: string,
  options: {
    pluginId?: string;
    version?: string;
    packageVersion?: string;
    minAppVersion?: string;
    withStyles?: boolean;
    withoutMain?: boolean;
  } = {},
): Promise<string> {
  const packageRoot = join(root, "pkg");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await writeFile(
    join(packageRoot, "manifest.json"),
    `${JSON.stringify({
      id: options.pluginId ?? RELEASE_PLUGIN_ID,
      name: "Candidate Bridge",
      version: options.version ?? VERSION,
      minAppVersion: options.minAppVersion ?? MIN_APP_VERSION,
      isDesktopOnly: true,
    })}\n`,
    "utf8",
  );
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "candidate", version: options.packageVersion ?? options.version ?? VERSION })}\n`,
    "utf8",
  );
  if (options.withoutMain !== true) {
    await writeFile(join(packageRoot, "dist", "main.js"), "// candidate main\n", "utf8");
  }
  if (options.withStyles === true) {
    await writeFile(join(packageRoot, "styles.css"), "/* candidate styles */\n", "utf8");
  }
  return packageRoot;
}

async function assembleCandidate(
  root: string,
  packageOptions: Parameters<typeof writePackageRoot>[1] = {},
  assembleOptions: { tag?: string } = {},
) {
  const packageRoot = await writePackageRoot(root, packageOptions);
  const bundleDirectory = join(root, "bundle");
  return assembleReleaseBundle({
    tag: assembleOptions.tag ?? TAG,
    packageRoot,
    bundleDirectory,
  });
}

async function verifyCandidate(
  bundleDirectory: string,
  overrides: Record<string, unknown> = {},
): Promise<VerifiedReleaseBundle> {
  return verifyReleaseBundle({ bundleDirectory, expectedTag: TAG, ...overrides });
}

async function readClaims(path: string): Promise<ReleaseAttestationClaims> {
  return JSON.parse(await readFile(path, "utf8")) as ReleaseAttestationClaims;
}

describe("release tag parsing", () => {
  it("accepts only immutable v-prefixed semantic versions", () => {
    expect(parseReleaseTag("v0.3.0")).toEqual({
      tag: "v0.3.0",
      version: "0.3.0",
      tagRef: "refs/tags/v0.3.0",
    });
    for (const mutable of ["latest", "0.3.0", "v0.3", "refs/tags/v0.3.0", "main", "v1.2.3 "]) {
      expect(() => parseReleaseTag(mutable)).toThrowError(
        expect.objectContaining({ code: "release_tag_malformed" }),
      );
    }
  });
});

describe("release bundle assembly", () => {
  it("assembles exactly the release-managed files deterministically", async () => {
    const root = await workspace();
    const first = await assembleCandidate(join(root, "a"), { withStyles: true });
    const second = await assembleCandidate(join(root, "b"), { withStyles: true });

    expect(first.tag).toBe(TAG);
    expect(first.files.map((file) => file.path).sort()).toEqual([
      "main.js",
      "manifest.json",
      "styles.css",
    ]);
    for (const file of ["manifest.json", "main.js", "styles.css", "checksums.sha256"]) {
      expect(await readFile(join(first.bundleDirectory, file), "utf8")).toBe(
        await readFile(join(second.bundleDirectory, file), "utf8"),
      );
    }
    const checksums = await readFile(join(first.bundleDirectory, "checksums.sha256"), "utf8");
    const lines = checksums.split("\n");
    expect(lines.at(-1)).toBe("");
    expect(lines.slice(0, -1)).toEqual([...lines.slice(0, -1)].sort());
    expect(first.claims.subjects.map((subject) => subject.name)).toEqual([
      "checksums.sha256",
      "main.js",
      "manifest.json",
      "styles.css",
    ]);
    expect(first.claims.workflowRef).toBe(
      `${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW_PATH}@refs/tags/${TAG}`,
    );
    expect(await readFile(first.attestationPath, "utf8")).toBe(
      await readFile(second.attestationPath, "utf8"),
    );
  });

  it("refuses tags that disagree with manifest or package versions", async () => {
    const root = await workspace();
    await expect(
      assembleCandidate(join(root, "a"), { version: "0.4.0" }),
    ).rejects.toMatchObject({ code: "release_tag_mismatch" });
    await expect(
      assembleCandidate(join(root, "b"), { packageVersion: "0.4.0" }),
    ).rejects.toMatchObject({ code: "release_tag_mismatch" });
    await expect(
      assembleCandidate(join(root, "c"), {}, { tag: "latest" }),
    ).rejects.toMatchObject({ code: "release_tag_malformed" });
  });

  it("refuses a foreign plugin id, missing build output, and a non-empty bundle directory", async () => {
    const root = await workspace();
    await expect(
      assembleCandidate(join(root, "a"), { pluginId: "someone-else" }),
    ).rejects.toMatchObject({ code: "release_plugin_id_mismatch" });
    await expect(
      assembleCandidate(join(root, "b"), { withoutMain: true }),
    ).rejects.toMatchObject({ code: "release_build_output_missing" });

    const packageRoot = await writePackageRoot(join(root, "c"));
    const bundleDirectory = join(root, "c", "bundle");
    await mkdir(bundleDirectory, { recursive: true });
    await writeFile(join(bundleDirectory, "stale.txt"), "stale\n", "utf8");
    await expect(
      assembleReleaseBundle({ tag: TAG, packageRoot, bundleDirectory }),
    ).rejects.toMatchObject({ code: "release_bundle_directory_not_empty" });
  });

  it("leaves no partial bundle when a required build output is missing", async () => {
    const root = await workspace();
    const packageRoot = await writePackageRoot(join(root, "a"), { withoutMain: true });
    const bundleDirectory = join(root, "a", "bundle");
    await expect(
      assembleReleaseBundle({ tag: TAG, packageRoot, bundleDirectory }),
    ).rejects.toMatchObject({ code: "release_build_output_missing" });
    // No manifest.json was copied before the missing main.js was detected: the
    // destination was never created, so a retry does not trip the not-empty
    // guard.
    await expect(readdir(bundleDirectory)).rejects.toMatchObject({ code: "ENOENT" });

    // Once the build output exists, the same directory assembles cleanly.
    await writeFile(join(packageRoot, "dist", "main.js"), "// candidate main\n", "utf8");
    const assembled = await assembleReleaseBundle({ tag: TAG, packageRoot, bundleDirectory });
    expect(assembled.files.map((file) => file.path).sort()).toEqual(["main.js", "manifest.json"]);
  });
});

describe("release bundle verification", () => {
  it("yields a branded verified bundle for an attested candidate", async () => {
    const root = await workspace();
    const assembled = await assembleCandidate(root, { withStyles: true });
    const verified = await verifyCandidate(assembled.bundleDirectory);

    expect(verified.tag).toBe(TAG);
    expect(verified.identity.pluginId).toBe(RELEASE_PLUGIN_ID);
    expect(verified.identity.pluginVersion).toBe(VERSION);
    expect(verified.repository).toBe(RELEASE_REPOSITORY);
    expect(verified.attestationSource).toBe("local-candidate");
    expect(verified.identity.files.map((file) => file.path)).toEqual([
      "main.js",
      "manifest.json",
      "styles.css",
    ]);
  });

  it("fails closed on missing or extra managed files", async () => {
    const root = await workspace();
    const assembled = await assembleCandidate(root);

    await rm(join(assembled.bundleDirectory, "main.js"));
    await expect(verifyCandidate(assembled.bundleDirectory)).rejects.toMatchObject({
      code: "candidate_file_missing",
    });

    const second = await assembleCandidate(join(root, "b"));
    await writeFile(join(second.bundleDirectory, "data.json"), "{}\n", "utf8");
    await expect(verifyCandidate(second.bundleDirectory)).rejects.toMatchObject({
      code: "candidate_file_unexpected",
    });
  });

  it("fails closed on changed bytes and on a missing or malformed checksum manifest", async () => {
    const root = await workspace();
    const assembled = await assembleCandidate(root);
    await writeFile(join(assembled.bundleDirectory, "main.js"), "// tampered\n", "utf8");
    await expect(verifyCandidate(assembled.bundleDirectory)).rejects.toMatchObject({
      code: "candidate_checksum_mismatch",
    });

    const missing = await assembleCandidate(join(root, "b"));
    await rm(join(missing.bundleDirectory, "checksums.sha256"));
    await expect(verifyCandidate(missing.bundleDirectory)).rejects.toMatchObject({
      code: "candidate_checksum_manifest_missing",
    });

    const malformed = await assembleCandidate(join(root, "c"));
    await writeFile(join(malformed.bundleDirectory, "checksums.sha256"), "not-a-checksum\n", "utf8");
    await expect(verifyCandidate(malformed.bundleDirectory)).rejects.toMatchObject({
      code: "candidate_manifest_invalid",
    });
  });

  it("fails closed when the bundle version or plugin id does not match the pinned tag", async () => {
    const root = await workspace();
    const assembled = await assembleCandidate(root);

    await expect(
      verifyCandidate(assembled.bundleDirectory, { expectedTag: "v0.4.0" }),
    ).rejects.toMatchObject({ code: "release_tag_mismatch" });
    await expect(
      verifyCandidate(assembled.bundleDirectory, { expectedPluginId: "other-plugin" }),
    ).rejects.toMatchObject({ code: "release_plugin_id_mismatch" });
    await expect(
      verifyCandidate(assembled.bundleDirectory, { expectedTag: "latest" }),
    ).rejects.toMatchObject({ code: "release_tag_malformed" });
  });

  it("fails closed when the runtime floor exceeds the supported Obsidian version", async () => {
    const root = await workspace();
    const assembled = await assembleCandidate(root, { minAppVersion: "99.0.0" });
    await expect(verifyCandidate(assembled.bundleDirectory)).rejects.toMatchObject({
      code: "release_incompatible_runtime",
    });
    // An equal floor and a lower floor remain installable.
    const equal = await assembleCandidate(join(root, "b"), { minAppVersion: "1.13.4" });
    await expect(verifyCandidate(equal.bundleDirectory)).resolves.toBeDefined();
    const lower = await assembleCandidate(join(root, "c"), { minAppVersion: "1.5.0" });
    await expect(verifyCandidate(lower.bundleDirectory)).resolves.toBeDefined();
  });

  it("fails closed on absent or malformed attestation", async () => {
    const root = await workspace();
    const absent = await assembleCandidate(join(root, "a"));
    await rm(absent.attestationPath);
    await expect(verifyCandidate(absent.bundleDirectory)).rejects.toMatchObject({
      code: "release_attestation_absent",
    });

    const malformed = await assembleCandidate(join(root, "b"));
    await writeFile(malformed.attestationPath, "{not json\n", "utf8");
    await expect(verifyCandidate(malformed.bundleDirectory)).rejects.toMatchObject({
      code: "release_attestation_malformed",
    });

    const wrongShape = await assembleCandidate(join(root, "c"));
    await expect(
      verifyCandidate(wrongShape.bundleDirectory, { attestation: { source: "mystery" } }),
    ).rejects.toMatchObject({ code: "release_attestation_malformed" });
  });

  it("fails closed on wrong repository or workflow identity, including mutable refs", async () => {
    const root = await workspace();
    const assembled = await assembleCandidate(root);
    const claims = await readClaims(assembled.attestationPath);

    await expect(
      verifyCandidate(assembled.bundleDirectory, {
        attestation: { ...claims, repository: "someone-else/fork" },
      }),
    ).rejects.toMatchObject({ code: "release_repository_mismatch" });

    for (const workflowRef of [
      `${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW_PATH}@refs/heads/main`,
      `${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW_PATH}@latest`,
      `${RELEASE_REPOSITORY}/.github/workflows/other.yml@refs/tags/${TAG}`,
      `${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW_PATH}@refs/tags/v9.9.9`,
    ]) {
      await expect(
        verifyCandidate(assembled.bundleDirectory, { attestation: { ...claims, workflowRef } }),
      ).rejects.toMatchObject({ code: "release_workflow_mismatch" });
    }
  });

  it("fails closed on missing, extra, or mis-hashed attestation subjects", async () => {
    const root = await workspace();
    const assembled = await assembleCandidate(root, { withStyles: true });
    const claims = await readClaims(assembled.attestationPath);

    const missingSubject = claims.subjects.filter((subject) => subject.name !== "main.js");
    await expect(
      verifyCandidate(assembled.bundleDirectory, {
        attestation: { ...claims, subjects: missingSubject },
      }),
    ).rejects.toMatchObject({ code: "release_attestation_subject_missing" });

    // The bundle carries styles.css, so a styled claim set is exact; claiming a
    // subject the bundle does not contain is proven against a plain bundle.
    const plain = await assembleCandidate(join(root, "b"));
    const plainClaims = await readClaims(plain.attestationPath);
    await expect(
      verifyCandidate(plain.bundleDirectory, {
        attestation: {
          ...plainClaims,
          subjects: [...plainClaims.subjects, { name: "styles.css", sha256: sha256("x") }],
        },
      }),
    ).rejects.toMatchObject({ code: "release_attestation_subject_unexpected" });

    const misHashed = claims.subjects.map((subject) =>
      subject.name === "main.js" ? { ...subject, sha256: "0".repeat(64) } : subject,
    );
    await expect(
      verifyCandidate(assembled.bundleDirectory, {
        attestation: { ...claims, subjects: misHashed },
      }),
    ).rejects.toMatchObject({ code: "release_attestation_digest_mismatch" });
  });

  it("converts verified gh attestation output into claims and verifies against them", async () => {
    const root = await workspace();
    const assembled = await assembleCandidate(root);
    const claims = await readClaims(assembled.attestationPath);
    const ghOutput = [
      {
        verificationResult: {
          statement: {
            subject: claims.subjects.map((subject) => ({
              name: subject.name,
              digest: { sha256: subject.sha256 },
            })),
          },
          verifiedCertificate: {
            extensions: {
              sourceRepositoryURI: `https://github.com/${RELEASE_REPOSITORY}`,
              buildSignerURI: `https://github.com/${claims.workflowRef}`,
            },
          },
        },
      },
    ];
    const converted = claimsFromGhAttestationVerifyOutput(ghOutput);
    expect(converted.source).toBe("github-artifact-attestation");
    expect(converted.repository).toBe(RELEASE_REPOSITORY);
    expect(converted.workflowRef).toBe(claims.workflowRef);

    const verified = await verifyCandidate(assembled.bundleDirectory, { attestation: converted });
    expect(verified.attestationSource).toBe("github-artifact-attestation");

    expect(() => claimsFromGhAttestationVerifyOutput([{ unexpected: true }])).toThrowError(
      expect.objectContaining({ code: "release_attestation_malformed" }),
    );
    expect(() => claimsFromGhAttestationVerifyOutput([])).toThrowError(
      expect.objectContaining({ code: "release_attestation_malformed" }),
    );
  });
});

describe("deployment accepts only the verifier's trusted result", () => {
  it("installs a verified bundle and refuses caller assertions", async () => {
    const root = await workspace();
    const assembled = await assembleCandidate(root);
    const vault = await provisionTestVault({ workingDirectory: root, runId: "deploy" });
    const verified = await verifyCandidate(assembled.bundleDirectory);

    const installed = await installCandidateBundle(verified, vault.vaultPath);
    const written = await readFile(join(installed.pluginDirectory, "main.js"), "utf8");
    expect(sha256(written)).toBe(verified.identity.files[0]!.sha256);

    // A plain object carrying the same fields — a caller assertion — is refused.
    await expect(
      installCandidateBundle(
        {
          bundleDirectory: assembled.bundleDirectory,
          identity: verified.identity,
          tag: TAG,
          repository: verified.repository,
          workflowRef: verified.workflowRef,
          attestationSource: "local-candidate",
        } as unknown as VerifiedReleaseBundle,
        vault.vaultPath,
      ),
    ).rejects.toMatchObject({ code: "candidate_unverified_bundle" });

    // A raw directory path is refused as well.
    await expect(
      installCandidateBundle(
        assembled.bundleDirectory as unknown as VerifiedReleaseBundle,
        vault.vaultPath,
      ),
    ).rejects.toMatchObject({ code: "candidate_unverified_bundle" });
  });
});
