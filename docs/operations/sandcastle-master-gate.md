# Sandcastle master gate

GitHub ruleset [`20992141`](https://github.com/canxer314/obsidian-llm-wiki-cli/settings/rules/20992141) protects `master` after the Bootstrap Pull Request was merged.

## Configuration

- Name: `Sandcastle master gate`
- Target: branch
- Enforcement: active
- Included ref: `refs/heads/master`
- Excluded refs: none
- Bypass actors: none
- Required status checks:
  - `sandcastle/local-quality`
  - `sandcastle/review`
- Require branches to be up to date before merging: yes
- Required approving reviews: 0
- Allowed merge methods: squash

The separate `Q10 local gate prototype` ruleset and its external test objects are outside this gate's ownership and must not be modified or removed as part of operating this gate.

## Verification

The isolated acceptance Pull Request and API responses for pending, failure, and current-head success states are recorded on [issue #114](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/114). Secrets, tokens, and OAuth credentials must not be included in that evidence.
