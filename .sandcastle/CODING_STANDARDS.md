# Coding Standards

Follow the repository-level `CLAUDE.md` and the guides under `docs/agents/`.

Run these commands before committing:

```bash
npm run build
npm run typecheck
npm test
```

Changes to the Sandcastle Docker runtime must also pass:

```bash
npm run test:sandbox
```
