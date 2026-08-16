FROM node:22-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ARG AGENT_UID=1000
ARG AGENT_GID=1000

RUN groupmod -o -g ${AGENT_GID} node \
  && usermod -o -u ${AGENT_UID} -g ${AGENT_GID} -d /home/agent -m -l agent node

RUN npm install -g \
    @anthropic-ai/claude-code@2.1.232 \
    @anthropic-ai/claude-code-linux-x64@2.1.232 \
  && node /usr/local/lib/node_modules/@anthropic-ai/claude-code/install.cjs \
  && claude --version

COPY --chown=${AGENT_UID}:${AGENT_GID} .sandcastle/skills/code-review/SKILL.md /home/agent/.claude/skills/code-review/SKILL.md
RUN printf '%s  %s\n' \
    'bab450f3b140af9327d945cf9bb12dc5c68bc0381f9afb1aea42083709fa5035' \
    '/home/agent/.claude/skills/code-review/SKILL.md' \
  | sha256sum --check --strict

USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent
ENTRYPOINT ["sleep", "infinity"]
