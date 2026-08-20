#!/usr/bin/env bash
set -euo pipefail

image_name="${SANDCASTLE_SMOKE_IMAGE:-sandcastle:obsidian-llm-wiki-cli-smoke}"
container_name="sandcastle-smoke-${RANDOM}-${RANDOM}"
worktree_path="${PWD}/.sandcastle/worktrees/${container_name}"

cleanup() {
  docker rm -f "${container_name}" >/dev/null 2>&1 || true
  git worktree remove --force "${worktree_path}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

git worktree add --detach "${worktree_path}" HEAD
rsync -a --delete \
  --exclude='.git' \
  --exclude='.claude' \
  --exclude='node_modules' \
  --exclude='.sandcastle/.env' \
  --exclude='.sandcastle/worktrees' \
  ./ "${worktree_path}/"

docker build \
  --build-arg "AGENT_UID=$(id -u)" \
  --build-arg "AGENT_GID=$(id -g)" \
  --file "${worktree_path}/.sandcastle/Dockerfile" \
  --tag "${image_name}" \
  "${worktree_path}"

docker run \
  --detach \
  --name "${container_name}" \
  --network host \
  --user "$(id -u):$(id -g)" \
  --volume "${worktree_path}:/home/agent/workspace" \
  --workdir /home/agent/workspace \
  "${image_name}" >/dev/null

network_mode="$(docker inspect --format '{{.HostConfig.NetworkMode}}' "${container_name}")"
[[ "${network_mode}" == "host" ]]

mount_count="$(docker inspect --format '{{len .Mounts}}' "${container_name}")"
mount_source="$(docker inspect --format '{{(index .Mounts 0).Source}}' "${container_name}")"
mount_destination="$(
  docker inspect --format '{{(index .Mounts 0).Destination}}' "${container_name}"
)"
[[ "${mount_count}" == "1" ]]
[[ "${mount_source}" == "${worktree_path}" ]]
[[ "${mount_destination}" == "/home/agent/workspace" ]]

docker exec "${container_name}" node --version
docker exec "${container_name}" npm --version
docker exec "${container_name}" sh -c \
  'printf '\''%s\n'\'' "$(node --version)" "$(npm --version)" | cmp --silent - /home/agent/.npm/sandcastle-runtime.versions'
docker exec "${container_name}" sha256sum --check --status /home/agent/.npm/sandcastle-image.sha256
docker exec "${container_name}" npm ci --offline
docker exec "${container_name}" npm run build
docker exec "${container_name}" npm run typecheck
docker exec "${container_name}" npm test
