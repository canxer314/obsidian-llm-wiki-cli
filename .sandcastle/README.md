# Sandcastle local Dispatcher

This directory holds the repository's production automation: a thin local WSL
Dispatcher and its fixed operations. The retired claim/watch/repair pipeline was
removed; GitHub Issues, Pull Requests, branches, labels, and comments are the
only durable business state. Canonical terms (Automation Command, Automation
Work Item, Blocked Automation, Dispatcher, Target Checkout, Legacy Run State)
are defined in `CONTEXT.md`.

The operator runbook — deployment, protected configuration, inspection, canary
sequence, and the single-writer cutover guard — lives at
`docs/operations/sandcastle-local-dispatcher-runbook.md`.

## Production entry

All commands run through the trusted local `master` checkout:

```bash
npm run sandcastle -- setup-labels
npm run sandcastle -- inspect
npm run sandcastle -- dispatch [--concurrency <1-8>]
npm run sandcastle -- run implement <issue-number>
npm run sandcastle -- run implement-prd <issue-number>
npm run sandcastle -- run split <issue-number>
npm run sandcastle -- run review <pr-number>
npm run sandcastle -- run feedback <pr-number>
npm run sandcastle -- run update-branch <pr-number>
npm run sandcastle -- architecture-review
```

## Private configuration

The private environment file lives outside the repository at
`~/.config/sandcastle/env` and must be mode `0600`:

```bash
install -m 600 /dev/null ~/.config/sandcastle/env
$EDITOR ~/.config/sandcastle/env
```

`.env.example` lists the whitelisted keys. The startup adapter reads only
routing, authentication, model-mapping, and proxy environment variables from
`~/.claude/settings.json`; non-empty whitelisted values in the private file
override those settings. Startup fails before creating an Agent Session if the
file is missing, is not mode `0600`, or required routing/authentication values
are unavailable. Startup logs contain counts only, never routes, model names,
proxy addresses, or secrets.

The default model is the Claude Code `opus` alias. `SANDCASTLE_MODEL` changes
the local default, while `SANDCASTLE_PLANNER_MODEL`,
`SANDCASTLE_IMPLEMENTER_MODEL`, and `SANDCASTLE_REVIEWER_MODEL` provide the
supported role-level overrides. Provider-specific model IDs belong only in the
private file or the local Claude Code settings.

Neither the private environment file nor complete Claude Code, CC-Switch,
OAuth, or GitHub CLI configuration is mounted into a container. The sandbox
provider receives only the adapter's filtered environment map.

## Agent runtime

`sandbox.ts` is the shared runtime and private-config entry point for
Sandcastle Agent Sessions. Orchestration entry points must call
`loadSandboxStartup()` and use its sandboxes, role models, and the
role-specific `sandboxHooksFor()` selection together; the unvalidated Docker
provider constructor is not exported.

The provider uses Docker host networking so a container can reach CC-Switch on
the WSL loopback interface. One fixed runtime image is built from the
repository context; it seeds an npm cache tied to the Dockerfile, lockfile,
workspace manifests, Node, and npm versions without retaining `node_modules`.
Implementer setup verifies that identity and runs `npm ci --offline`. Planner
setup deliberately has no dependency-install hook. Do not add `node_modules` to
`copyToWorktree`. Proxy variables are explicitly whitelisted; credential files
are excluded from every Docker build context.

Build and verify the image with:

```bash
npm run test:sandbox
```

The smoke test creates a detached Git worktree, mounts only that worktree, and
runs `npm ci`, build, typecheck, and the complete test suite in Node.js 24. It
does not load credentials or start an Agent Session.
