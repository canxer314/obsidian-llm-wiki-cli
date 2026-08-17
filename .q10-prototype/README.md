# Q10 local gate prototype

Throwaway primary source for testing a local Sandcastle quality gate without GitHub Actions or a GitHub-hosted runner.

## Question

Can a small local executor run the repository quality commands, publish a status for the exact PR head SHA, reject stale-head results, and rely on a GitHub ruleset to block ordinary merges until that status succeeds?

## Result

Yes.

- Pending `sandcastle/local-quality`: ordinary squash merge rejected.
- Failed `sandcastle/local-quality`: ordinary squash merge rejected.
- Successful status after `npm ci`, build, typecheck, and 319 tests: ordinary squash merge accepted.
- A head change during execution was detected and published as `error`; merge was not called.
- Docker bridge networking repeatedly caused npm `ECONNRESET`; host networking completed successfully.
- Warm-cache end-to-end execution took about 31–37 seconds.

The GitHub test used PR #95 and temporary ruleset 20940201, matching only `prototype/q10-local-gate-base`. No bypass actor was configured and the current administrator identity reported `current_user_can_bypass=never`.
