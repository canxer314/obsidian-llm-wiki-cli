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
    '29f1ac715f1a2acb97a694b958531a032249ab0ad662aa28b40ba54c4bdb2ab0' \
    '/home/agent/.claude/skills/code-review/SKILL.md' \
  | sha256sum --check --strict

USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent
ENTRYPOINT ["sleep", "infinity"]
