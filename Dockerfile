FROM node:22-bookworm-slim

ARG PI_VERSION=0.99.1
ARG PI_WEB_UI_VERSION=0.96.1

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      bash ca-certificates curl git jq openssh-client ripgrep \
      python3 make g++ && \
    npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" && \
    npm install -g "pi-web-ui@${PI_WEB_UI_VERSION}" && \
    npm install --prefix /usr/local/lib/node_modules/pi-web-ui --ignore-scripts --omit=dev --no-save "@earendil-works/pi-coding-agent@${PI_VERSION}" && \
    rm -rf /root/.npm /var/lib/apt/lists/*

# node:22-bookworm-slim already provides node:node at UID/GID 1000.
# Reuse that account instead of trying to create a conflicting second 1000:1000 user.
RUN set -eux; \
    test "$(id -u node)" = "1000"; \
    test "$(id -g node)" = "1000"; \
    usermod --login pi --home /home/pi --move-home --shell /bin/bash node; \
    groupmod --new-name pi node; \
    test "$(id -u pi)" = "1000"; \
    test "$(id -g pi)" = "1000"; \
    mkdir -p /workspace /home/pi/.pi/agent /home/pi/.pi-web /home/pi/.config/mcp /etc/pi; \
    chown -R pi:pi /workspace /home/pi

COPY --chown=pi:pi scripts/container-entrypoint.sh /usr/local/bin/pi-container-entrypoint
COPY --chown=pi:pi scripts/sync-ollama-models.mjs /usr/local/lib/pi-docker/sync-ollama-models.mjs
COPY scripts/patch-web-tool-policy.mjs scripts/configure-tool-policy.mjs /usr/local/lib/pi-docker/
COPY extensions/mcp-gate/package*.json /opt/pi-mcp-gate/
RUN cd /opt/pi-mcp-gate && npm ci --ignore-scripts --omit=dev --no-audit --no-fund
COPY extensions/mcp-gate/index.ts extensions/mcp-gate/gate.mjs extensions/mcp-gate/reasoning.mjs /opt/pi-mcp-gate/
RUN node /usr/local/lib/pi-docker/patch-web-tool-policy.mjs /usr/local/lib/node_modules/pi-web-ui
RUN chmod 0755 /usr/local/bin/pi-container-entrypoint

USER pi
ENV HOME=/home/pi \
    PI_CODING_AGENT_DIR=/home/pi/.pi/agent \
    PI_WEB_DATA_DIR=/home/pi/.pi-web \
    PI_WEB_CWD=/workspace \
    PI_WEB_HOST=0.0.0.0 \
    PI_WEB_PORT=8787

WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/pi-container-entrypoint"]
CMD ["pi-web-ui", "--no-browser"]
