#!/usr/bin/env bash
set -euo pipefail

if [[ "${AFK_CONTAINER_SMOKE:-}" != "1" ]]; then
  printf '%s\n' 'Set AFK_CONTAINER_SMOKE=1 to run the opt-in container smoke test.' >&2
  exit 2
fi

: "${MODEL_GATEWAY_URL:?MODEL_GATEWAY_URL is required}"
: "${MODEL_GATEWAY_TOKEN:?MODEL_GATEWAY_TOKEN is required}"

settings_path="$(realpath -- "${AFK_CLAUDE_SETTINGS:-$HOME/.claude/settings-docker.json}")"
if [[ ! -f "$settings_path" ]]; then
  printf '%s\n' 'AFK_CLAUDE_SETTINGS must name a container-specific settings file' >&2
  exit 2
fi

delivery_image="${AFK_DELIVERY_IMAGE:-sandcastle:obsidian-llm-wiki-cli}"
reviewer_image="${AFK_REVIEWER_IMAGE:-sandcastle:obsidian-llm-wiki-cli-reviewer}"
model="${AFK_MODEL:-fable}"
context_window="${AFK_CONTEXT_WINDOW:-372000}"
script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(dirname -- "$script_directory")"
case "$MODEL_GATEWAY_URL" in
  http://localhost:*|http://127.0.0.1:*|http://host.docker.internal:*) ;;
  *)
    if [[ "${AFK_ALLOW_REMOTE_GATEWAY:-}" != "1" ]]; then
      printf '%s\n' 'MODEL_GATEWAY_URL must target the local cc-switch gateway' >&2
      exit 2
    fi
    ;;
esac

runtime_network_args=()
case "$MODEL_GATEWAY_URL" in
  http://localhost:*|http://127.0.0.1:*) runtime_network_args=(--network host) ;;
esac

docker image inspect "$delivery_image" "$reviewer_image" >/dev/null

docker run --rm --entrypoint sh "$delivery_image" -c '
  test "$(id -u)" != 0
  test ! -e /var/run/docker.sock
  test ! -e "$HOME/.config/gh"
  test ! -e "$HOME/.ssh"
  test ! -e "$HOME/.claude.json"
  test ! -e "$HOME/.claude/settings.json"
  test -z "${GITHUB_TOKEN:-}${GH_TOKEN:-}"
  while IFS="=" read -r name expected; do
    actual="$(sha256sum "/opt/afk-delivery/skills/${name%.sha256}/SKILL.md" | cut -d" " -f1)"
    test "$actual" = "$expected"
  done < /opt/afk-delivery/skills.lock
'

printf '%s' 'Read the repository README and reply with exactly IMPLEMENTATION_READ_ONLY_OK. Do not edit files or run commands.' |
  docker run --rm -i \
    "${runtime_network_args[@]}" \
    --read-only \
    --cap-drop=ALL \
    --security-opt=no-new-privileges \
    --cpus 1 \
    --pids-limit=256 \
    --add-host host.docker.internal:host-gateway \
    --mount "type=bind,source=$repository_root,target=/workspace,readonly" \
    --mount "type=bind,source=$settings_path,target=/opt/afk-delivery/settings.json,readonly" \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
    --tmpfs /home/agent:rw,nosuid,nodev,size=128m,uid=1000,gid=1000,mode=0700 \
    --env MODEL_GATEWAY_URL \
    --env MODEL_GATEWAY_TOKEN \
    --env AFK_MODEL="$model" \
    --env AFK_CONTEXT_WINDOW="$context_window" \
    --env AFK_MAX_ITERATIONS=3 \
    "$delivery_image" | grep -F 'IMPLEMENTATION_READ_ONLY_OK'

docker run --rm --entrypoint sh "$reviewer_image" -c '
  test "$(id -u)" != 0
  test ! -e /var/run/docker.sock
  test ! -e "$HOME/.config/gh"
  test ! -e "$HOME/.ssh"
  test ! -e "$HOME/.claude.json"
  test ! -e "$HOME/.claude/settings.json"
  test -z "${GITHUB_TOKEN:-}${GH_TOKEN:-}"
'

printf '%s' 'Reply with exactly REVIEW_READ_ONLY_OK. Do not use tools.' |
  docker run --rm -i \
    "${runtime_network_args[@]}" \
    --read-only \
    --cap-drop=ALL \
    --security-opt=no-new-privileges \
    --cpus 1 \
    --pids-limit=256 \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
    --tmpfs /home/agent/.claude/runtime:rw,noexec,nosuid,nodev,size=64m \
    --env ANTHROPIC_BASE_URL="$MODEL_GATEWAY_URL" \
    --env ANTHROPIC_AUTH_TOKEN="$MODEL_GATEWAY_TOKEN" \
    --entrypoint claude \
    "$reviewer_image" \
      --bare \
      --print \
      --model claude-opus-5 \
      --effort low \
      --tools '' \
      --permission-mode dontAsk \
      --no-session-persistence \
      --strict-mcp-config \
      --mcp-config '{"mcpServers":{}}' | grep -F 'REVIEW_READ_ONLY_OK'
