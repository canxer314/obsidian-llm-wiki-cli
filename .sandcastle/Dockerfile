FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

ARG CLAUDE_CODE_VERSION=2.1.233
ARG CLAUDE_CODE_INTEGRITY=sha512-WS0ZSsNu2zkQonC+rW7HdByMCkPQ2l+hO1G0LdvWTj40kiYr0qAiSJjCBNRIbi0foBol4IFTCKwLHAN83qxxUQ==

COPY verify-integrity.mjs /opt/build/verify-integrity.mjs

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/* \
    && groupmod --new-name agent node \
    && usermod --login agent --home /home/agent --move-home --shell /bin/bash node

RUN npm pack "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" --pack-destination /opt/build \
    && node /opt/build/verify-integrity.mjs "/opt/build/anthropic-ai-claude-code-${CLAUDE_CODE_VERSION}.tgz" "${CLAUDE_CODE_INTEGRITY}" \
    && npm install --global --allow-scripts=@anthropic-ai/claude-code "/opt/build/anthropic-ai-claude-code-${CLAUDE_CODE_VERSION}.tgz" \
    && claude --version \
    && rm -rf /opt/build

COPY skills.lock /opt/afk-delivery/skills.lock
COPY skills /opt/afk-delivery/skills
COPY entrypoint.mjs /opt/afk-delivery/entrypoint.mjs
COPY verify-model.mjs /opt/afk-delivery/verify-model.mjs

RUN set -eu; \
    while IFS='=' read -r name expected; do \
      actual="$(sha256sum "/opt/afk-delivery/skills/${name%.sha256}/SKILL.md" | cut -d' ' -f1)"; \
      test "$actual" = "$expected"; \
    done < /opt/afk-delivery/skills.lock; \
    chown -R root:root /opt/afk-delivery; \
    chmod -R a-w /opt/afk-delivery

USER agent
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/afk-delivery/entrypoint.mjs"]
