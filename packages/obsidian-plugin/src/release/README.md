# Release bundles (issue #196)

Version-pinned candidate Release bundles for the lifecycle operations of
spec §9.1 / parent spec #42. Downstream deployment consumes a bundle only
after its immutable identity, provenance, contents, integrity, and runtime
compatibility have been verified; final public Release publication and the
release verdict remain owned by #45.

## Pieces

- `release-identity.ts` — the pinned identity constants (plugin id,
  repository, protected workflow path), immutable `vX.Y.Z` tag parsing
  (`latest` and other mutable selectors are inexpressible), and the failure
  codes shared by assembly and verification.
- `assemble-release-bundle.ts` — deterministic packaging: for one fixed tag,
  assembles exactly the release-managed files (`manifest.json`, `main.js`,
  optional `styles.css`) plus a canonical LF-sorted `checksums.sha256`, and
  writes the attestation claims document as a sibling file (attestations live
  outside the closed bundle file set, as in the GitHub attestation store).
  Assembly refuses version/tag or plugin-id mismatches and non-empty bundle
  directories.
- `attestation-claims.ts` — the closed claims shape (`source`, `repository`,
  `workflowRef`, exact SHA-256 subject set) plus conversion of verified
  `gh attestation verify --format json` output into canonical claims; the
  repository and signer workflow are read from the verified certificate, not
  from the environment.
- `verify-release-bundle.ts` — the only source of installable bundles. Fails
  closed on bundle-integrity defects, tag/version or plugin-id mismatch,
  Obsidian `minAppVersion` incompatibility, and any attestation defect
  (absent, malformed, wrong repository/workflow, missing/extra/mis-hashed
  subjects). Success yields a `VerifiedReleaseBundle` carrying a
  module-private brand; `installCandidateBundle` rejects anything without it,
  so a raw directory, arbitrary URL, or caller assertion can never be
  installed and no skip-verification path exists.
- `assemble-cli.ts` / `verify-cli.ts` — self-contained executables
  (`dist/release-assemble.mjs`, `dist/release-verify.mjs`) used by
  `.github/workflows/release.yml`, the CI candidate-bundle job, and local
  operators.

## Workflow binding

`.github/workflows/release.yml` runs on immutable tag pushes (or an explicit
tag via `workflow_dispatch`), assembles the candidate bundle, generates a
GitHub artifact attestation with `actions/attest-build-provenance`, then
verifies the attested artifact with the same module the tests cover. It never
publishes a GitHub Release. `.github/workflows/ci.yml` exercises the same
assemble → verify path with a `local-candidate` attestation on every push.
