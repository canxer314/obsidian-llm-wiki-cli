# Sandcastle sandbox

`./sandbox.ts` is the shared runtime configuration for Sandcastle Agent Sessions.
Orchestration entry points should import both `createSandboxProvider()` and
`sandboxHooks` rather than constructing their own Docker provider or setup hook.

The provider uses Docker host networking so a container can reach CC-Switch on
the WSL loopback interface. The setup hook runs `npm ci` in each new sandbox;
do not add `node_modules` to `copyToWorktree`.

Build and verify the image with:

```bash
npm run test:sandbox
```

The smoke test creates a detached Git worktree, mounts only that worktree, and
runs `npm ci`, build, typecheck, and the complete test suite in Node.js 24. It
does not load credentials or start an Agent Session. Private configuration and
Agent orchestration are delivered by their dedicated follow-up issues.
