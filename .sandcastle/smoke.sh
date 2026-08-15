#!/usr/bin/env bash
set -euo pipefail

if [[ "${AFK_CONTAINER_SMOKE:-}" != "1" ]]; then
  printf '%s\n' 'Set AFK_CONTAINER_SMOKE=1 to run the opt-in container smoke test.' >&2
  exit 2
fi

: "${MODEL_GATEWAY_URL:?MODEL_GATEWAY_URL is required}"
: "${MODEL_GATEWAY_TOKEN:?MODEL_GATEWAY_TOKEN is required}"

image="${AFK_DELIVERY_IMAGE:-afk-delivery:smoke}"
model="${AFK_MODEL:-claude-opus-5}"
case "$MODEL_GATEWAY_URL" in
  http://localhost:*|http://127.0.0.1:*|http://host.docker.internal:*) ;;
  *)
    if [[ "${AFK_ALLOW_REMOTE_GATEWAY:-}" != "1" ]]; then
      printf '%s\n' 'MODEL_GATEWAY_URL must target the local cc-switch gateway' >&2
      exit 2
    fi
    ;;
esac

build_args=(--tag "$image")
for name in HTTP_PROXY HTTPS_PROXY NO_PROXY; do
  if [[ -n "${!name:-}" ]]; then
    build_args+=(--build-arg "$name=${!name}")
  fi
done
if [[ "${HTTP_PROXY:-}${HTTPS_PROXY:-}" == *"127.0.0.1:"* ||
      "${HTTP_PROXY:-}${HTTPS_PROXY:-}" == *"localhost:"* ]]; then
  build_args+=(--network host)
fi
docker build "${build_args[@]}" .sandcastle

docker run --rm --entrypoint sh "$image" -c '
  test "$(id -u)" != 0
  test ! -e /var/run/docker.sock
  while IFS="=" read -r name expected; do
    actual="$(sha256sum "/opt/afk-delivery/skills/${name%.sha256}/SKILL.md" | cut -d" " -f1)"
    test "$actual" = "$expected"
  done < /opt/afk-delivery/skills.lock
  test ! -e "$HOME/.config/gh"
  test ! -e "$HOME/.ssh"
  test -z "${GITHUB_TOKEN:-}${GH_TOKEN:-}"
'

docker run --rm \
  --add-host host.docker.internal:host-gateway \
  --env MODEL_GATEWAY_URL \
  --env MODEL_GATEWAY_TOKEN \
  --env AFK_MODEL="$model" \
  --entrypoint sh \
  "$image" -c '
    export ANTHROPIC_AUTH_TOKEN="$MODEL_GATEWAY_TOKEN"
    curl --fail --silent --show-error \
      --header "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" \
      "$MODEL_GATEWAY_URL/v1/models" |
      node /opt/afk-delivery/verify-model.mjs "$AFK_MODEL" 1000000
  '

printf '%s' 'Read the repository README and reply with exactly READ_ONLY_OK. Do not edit files or run commands.' |
  docker run --rm \
    --read-only \
    --cpus 1 \
    --add-host host.docker.internal:host-gateway \
    --mount "type=bind,source=$PWD,target=/workspace,readonly" \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
    --tmpfs /home/agent:rw,nosuid,nodev,size=128m \
    --env MODEL_GATEWAY_URL \
    --env MODEL_GATEWAY_TOKEN \
    --env AFK_MODEL="$model" \
    --env AFK_CONTEXT_WINDOW=1000000 \
    --env AFK_MAX_ITERATIONS=1 \
    "$image" | grep -F 'READ_ONLY_OK'
