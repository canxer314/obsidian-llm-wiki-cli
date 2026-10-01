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

## Installed partial slices and full acceptance

The built-in crash adapter executes independently supervised create-note and
exact edit-body slices at `after_prepared` and `after_committed`. The create-note
PREPARED slice must restore an absent file; the edit-body PREPARED slice must
retain exact original bytes. Both retain `intent_not_applied`. COMMITTED slices
must preserve exact committed bytes and retain `intent_applied`. All four bind the durable Journal, pre-crash status,
post-restart status, and replayed complete Change Set record to the same identity.
Their success does not cover every mutation/fault boundary or retention case, so
the crash corpus still fails closed rather than promoting these slices.

The built-in gate slice observes both Vaults' healthy open gate through actual
MCP health, discovery inventory, metadata read, and unknown-key status before
checking registry isolation. It does not prove blocked/paused/maintenance gate
rows, FIFO, or a protocol-mismatch registry-inspection counter.

The lifecycle adapter runs candidate installation/repair and offline
uninstall/lossless reinstall before checking the external previous release.
Each launched runtime is checked against the registered environment and installed
candidate bytes. Generated registration commands and simulated registration
flags in the underlying scenario are not installed authority. Upgrade, explicit
local resume, Agent registration/removal, refusal cases, and confirmed purge
remain required for full lifecycle acceptance.

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

`waitForNextInstalledLocalControlReport` discovers the real local invocation ID
from control report files. The runner consumes actions serially and records already
consumed IDs; it does not invent IDs or infer invocation order from hashes or file
modification times. Multiple pending reports for the requested action are ambiguous
and fail closed. Every discovered control report is validated, including consumed
reports and reports for other actions; neither category bypasses identity or
checksum checks.

`waitForNextInstalledLocalContentReport` likewise discovers real confirmation IDs
and requires the expected selection SHA-256. It validates even consumed reports,
checks copied version facts against the installed contract, and rejects multiple
pending confirmations rather than guessing their order. It never opens a modal or
copies a selection. Report-protocol tests do not prove a Primary Operator actually
cancelled or confirmed a fresh installed modal.

The built-in privacy adapter uses independent report roots for its two generated
Vaults and waits up to 180 seconds per local report. It first observes the six-tool
Agent authority boundary, then runs the existing installed trash/restore evidence
failure fixture only in Vault A, retaining Vault B as an unaffected control. Before requesting a standard copy, it waits for the identity-bound
scenario completion and cleanup, checks the durable Vault-bound `FAILED` frame,
and observes the corresponding public `result_unproven` status and blocked health.
It never invokes the local copy command. Missing or invalid local evidence fails
closed, and runtime/listener shutdown must be confirmed before generated-root
cleanup. The built-in adapter then observes Vault B's rejected baseline, Vault A's accepted
baseline, and a separate Vault A resume report, in that order. It independently
checks cleared Journal slots, live paused/writable health and status projections,
unchanged complete historical Change Set records, and unaffected Vault B
observations. It only asks for reports; the Primary Operator must perform each
local command. These observations still remain partial: fresh content confirmations,
complete corpus aggregation, and the remaining gate/crash/lifecycle cases are
required for full acceptance.
