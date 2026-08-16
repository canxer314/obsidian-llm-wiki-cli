#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'usage: %s <immutable-review-bundle.json>\n' "$0" >&2
  exit 64
fi

source_bundle=$(realpath "$1")
if [[ ! -f "$source_bundle" ]]; then
  printf 'review bundle does not exist: %s\n' "$source_bundle" >&2
  exit 66
fi

snapshot_directory=$(mktemp -d)
chmod 0700 "$snapshot_directory"
trap 'rm -rf "$snapshot_directory"' EXIT
bundle_file="$snapshot_directory/input.json"
install -m 0400 "$source_bundle" "$bundle_file"

node --input-type=module - "$bundle_file" <<'NODE' || {
import { readFile } from "node:fs/promises";

const bundle = JSON.parse(await readFile(process.argv[2], "utf8"));
const revision = /^[0-9a-f]{40}$/u;
const documentsAreComplete = (documents) =>
  Array.isArray(documents) && documents.length > 0 && documents.every(
    (document) =>
      typeof document?.path === "string" && document.path.trim().length > 0 &&
      typeof document?.content === "string" && document.content.trim().length > 0,
  );
const expectedCapabilities = {
  sourceReadOnly: true,
  canEdit: false,
  canCommit: false,
  canPush: false,
  canComment: false,
  githubCredentials: false,
};
const valid =
  Number.isInteger(bundle.ticket?.number) &&
  typeof bundle.ticket?.body === "string" && bundle.ticket.body.trim().length > 0 &&
  typeof bundle.repositoryInstructions === "string" && bundle.repositoryInstructions.trim().length > 0 &&
  documentsAreComplete(bundle.domainDocuments) &&
  documentsAreComplete(bundle.architectureDecisions) &&
  revision.test(bundle.baseRevision) &&
  revision.test(bundle.headRevision) &&
  bundle.baseRevision !== bundle.headRevision &&
  typeof bundle.diff === "string" && bundle.diff.startsWith("diff --git ") &&
  Number.isInteger(bundle.round) && bundle.round >= 1 &&
  bundle.skill?.path === "/home/agent/.claude/skills/code-review/SKILL.md" &&
  bundle.skill?.revision === "sha256:bab450f3b140af9327d945cf9bb12dc5c68bc0381f9afb1aea42083709fa5035" &&
  JSON.stringify(bundle.capabilities) === JSON.stringify(expectedCapabilities);
if (!valid) process.exit(1);
NODE
  printf 'review bundle is incomplete, ambiguous, or not capability-isolated\n' >&2
  exit 65
}

image=${AFK_REVIEWER_IMAGE:-sandcastle:obsidian-llm-wiki-cli-reviewer}
timeout_seconds=${AFK_REVIEW_TIMEOUT_SECONDS:-1800}

credential_args=()
for name in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL; do
  if [[ -n ${!name:-} ]]; then
    credential_args+=(--env "$name")
  fi
done

exec timeout --signal=TERM --kill-after=30 "${timeout_seconds}" \
  docker run --rm --interactive \
    --read-only \
    --cap-drop=ALL \
    --security-opt=no-new-privileges \
    --network=host \
    --cpus=4 \
    --memory=8g \
    --pids-limit=256 \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m \
    --tmpfs /home/agent/.claude/runtime:rw,noexec,nosuid,nodev,size=64m \
    --volume "$bundle_file:/review/input.json:ro" \
    --workdir /home/agent \
    "${credential_args[@]}" \
    --entrypoint claude \
    "$image" \
      --bare \
      --print \
      --model claude-opus-5 \
      --effort xhigh \
      --tools Read \
      --permission-mode dontAsk \
      --no-session-persistence \
      --strict-mcp-config \
      --mcp-config '{"mcpServers":{}}' \
      '/code-review Review only the complete immutable evidence bundle at /review/input.json. Return the full Review Handoff without summarization.'
