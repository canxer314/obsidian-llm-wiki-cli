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
