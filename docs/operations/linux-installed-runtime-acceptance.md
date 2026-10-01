# Linux installed-runtime acceptance

`MVP-PERF-REF-LINUX-1` is the separately registered Linux acceptance profile:

- Linux kernel `7.0.0-31-generic`;
- Obsidian `1.13.7`, Electron `43.3.0`, embedded Node `24.18.1`;
- POSIX fixtures, loopback HTTP, a graphical desktop, and process-group control;
- a generated Vault and dedicated profile with only the candidate community plugin enabled.

Do not use the Primary Operator's daily Vault or profile. The harness provisions
its own roots, installs a verified candidate, and supervises the generated GUI's
local Vault-trust confirmation through a separate loopback debugging connection.
That connection is not an MCP tool or Agent Session recovery capability.

Create a registration JSON using the installed executable and embedded runtime
versions (not the shell's Node version):

```json
{
  "obsidianExecutable": "/opt/Obsidian/obsidian",
  "obsidianVersion": "1.13.7",
  "electronVersion": "43.3.0",
  "nodeVersion": "24.18.1"
}
```

Run with an explicit profile; the CLI's historical default remains the Windows
reference profile:

```sh
npm run smoke:installed-runtime --workspace=@llm-wiki/obsidian-vault-bridge -- \
  --registration /path/to/linux-registration.json \
  --workdir /path/to/acceptance-workdir \
  --profile MVP-PERF-REF-LINUX-1 \
  --previous-release /path/to/verified-older-release \
  --previous-release-tag vX.Y.Z
```

The previous release must be a genuine, verified bundle with a version strictly
lower than the candidate; relabelling candidate bytes as an older release is not
allowed. Runtime registration alone does not prove acceptance: required corpora,
installed-candidate provenance, concrete assertions, and confirmed cleanup must
all pass. Missing adapters or previous-release inputs fail closed. Consult the
written evidence verdict rather than treating a successful plugin unit-test run
as installed-runtime acceptance.

## Local Primary Operator observations

An armed generated Vault records evidence from the existing local commands; the
private acceptance channel does not dispatch any diagnostic, baseline, or resume
operation. The Agent must not invoke these commands through the debugging
connection or impersonate the Primary Operator.

- **Copy standard diagnostic bundle** records
  `local-standard-diagnostic-copy.json` only after the clipboard write succeeds.
  It contains the closed redacted bundle, whose checksum can be independently
  verified. The first report cannot be overwritten.
- **Copy selected content-inclusive diagnostics** opens a fresh confirmation
  modal for each invocation. Cancellation records no generation or copy;
  successful copy records the verified bundle checksum, version facts, and
  selection digest, not the selected text. Reports are named
  `local-content-inclusive-diagnostic-copy-<confirmation-id-sha256>.json`.
- **Pause Managed Vault writes**, **Accept trusted Managed Vault recovery
  baseline**, and **Resume Managed Vault writes** record accepted or rejected
  outcomes with verified before/after redacted diagnostic bundles in
  `local-write-control-<invocation-id-sha256>.json`. Merely accepting a baseline
  does not claim that a subsequent resume occurred.

These reports are bound to the descriptor's run, candidate bundle, installed
entry point, capability, Vault identity, endpoint, and pinned report directory.
They use private file permissions and atomic no-replace publication. They remain
local evidence containing a capability: do not publish the raw report files.
No local command invocation means no local authority proof. Reports alone do not
complete the full privacy/recovery corpus or A-01…A-44 aggregation; the installed
runner must also verify scenario preconditions, history, isolation, and cleanup.

The local report consumer reloads the installed descriptor and verifies the
installed entry-point digest before reading evidence. It rejects redirected
report directories, non-private files, foreign run identities, and any endpoint
other than `http://127.0.0.1:<port>/mcp` without credentials, query, or fragment.
Standard and write-control bundle checksums are recomputed; a writer's
`checksumVerified` declaration is not itself proof.

An accepted baseline report must begin with blocked recovery and a unique latest
valid `FAILED` Journal frame, then show cleared Journal slots, recovery `none`,
and writes still paused. A rejected baseline must preserve recovery/write and
Journal facts. Both outcomes must preserve the stable terminal outcome projection
(enqueue sequence, state, and execution phase); randomized diagnostic aliases are
not compared across copies. This projection is not a substitute for the runner's
independent historical Change Set identity/status observations.

`waitForInstalledLocalOperatorReport` observes reports with a bounded timeout. It
never dispatches a local action. Only a missing report is retried: an absent
installed descriptor, changed bundle, malformed report, or failed validation is
an immediate failure. Missing Primary Operator evidence cannot become a passed
corpus by waiting or by substituting an Agent invocation.
