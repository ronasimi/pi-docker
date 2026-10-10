FROM node:22.20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git jq openssh-client ripgrep python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# One lockfile, one stock SDK, shared by the CLI and stock Web UI.
WORKDIR /opt/pi-runtime
COPY runtime/package.json runtime/package-lock.json runtime/versions.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && \
    npm rebuild node-pty && rm -rf /root/.npm
ENV PATH="/opt/pi-runtime/node_modules/.bin:${PATH}" \
    PI_RUNTIME_ROOT=/opt/pi-runtime \
    PI_SDK_ROOT=/opt/pi-runtime/node_modules/@earendil-works/pi-coding-agent \
    PI_WEB_UI_ROOT=/opt/pi-runtime/node_modules/pi-web-ui \
    PI_VERSIONS_FILE=/opt/pi-runtime/versions.json \
    PI_NATIVE_SERVICES_PATH=/opt/pi-extensions/pi-native-services \
    PI_ATOMIC_EXTENSION_PATH=/opt/pi-extensions/pi-atomic-tool-results \
    PI_ATOMIC_RESULTS_FIXED_PROVIDER_TOOLS=true \
    PI_WEB_SDK=bundled

RUN usermod --login pi --home /home/pi --move-home --shell /bin/bash node && \
    groupmod --new-name pi node && \
    mkdir -p /workspace /home/pi/.pi/agent /home/pi/.pi-web /etc/pi /opt/pi-app && \
    chown -R pi:pi /workspace /home/pi

# All custom behavior is external to installed upstream packages.
COPY --chown=pi:pi scripts/check.sh scripts/analyze-agent-loop.mjs scripts/apply-runtime-policy.mjs scripts/check-prompt-contract.mjs scripts/config-common.mjs scripts/configure-ollama-32k.mjs scripts/configure-qwen-trial.py scripts/container-entrypoint.sh scripts/diagnostic-trial-config.mjs scripts/down.sh scripts/init.sh scripts/inspect-ollama-runtime.mjs scripts/logs.sh scripts/model-policy.mjs scripts/prepare-qwen-trial.mjs scripts/probe-qwen-trial.mjs scripts/run-uncapped-trial.sh scripts/runtime-versions.mjs scripts/setup-qwen.sh scripts/status.sh scripts/sync-models.sh scripts/sync-ollama-models.mjs scripts/test-runtime.mjs scripts/upstream-integrity.mjs scripts/validate-image.sh scripts/verify-runtime-session.mjs scripts/verify-stock-runtime.mjs /opt/pi-app/scripts/
COPY --chown=pi:pi extensions/pi-native-services /opt/pi-extensions/pi-native-services/
COPY --chown=pi:pi extensions/pi-atomic-tool-results /opt/pi-extensions/pi-atomic-tool-results/
COPY --chown=pi:pi config/settings.json config/web-settings.json config/mcp.json config/APPEND_SYSTEM.md config/models-overrides.json config/models-fallback.json /opt/pi-app/config/
COPY --chown=pi:pi config/skills /opt/pi-app/config/skills/
COPY --chown=pi:pi tests/cli.integration.test.mjs tests/agent-loop-benchmark.test.mjs tests/clean-base.test.mjs tests/image-policy.test.mjs tests/optional-mcp-health.test.mjs tests/prompt-contract.test.mjs tests/qwen-host-modes.test.py tests/qwen-lease9-budget.test.mjs tests/qwen-trial.test.mjs tests/runtime.integration.test.mjs /opt/pi-app/tests/
COPY --chown=pi:pi setup-qwen.sh /opt/pi-app/setup-qwen.sh
COPY --chown=pi:pi tests/fixtures /opt/pi-app/tests/fixtures/
COPY runtime/package.json runtime/package-lock.json runtime/versions.json /opt/pi-app/runtime/
COPY Dockerfile /opt/pi-app/Dockerfile
RUN ln -s /opt/pi-extensions /opt/pi-app/extensions && \
    ln -s /opt/pi-app/scripts /usr/local/lib/pi-docker && \
    cp -a /opt/pi-app/config/. /etc/pi/ && \
    cp /etc/pi/settings.json /etc/pi/default-settings.json && \
    cp /etc/pi/web-settings.json /etc/pi/default-web-settings.json && \
    node /opt/pi-app/scripts/upstream-integrity.mjs /opt/pi-runtime --record && \
    chmod -R a-w /opt/pi-runtime/node_modules

USER pi
RUN node /opt/pi-app/scripts/verify-stock-runtime.mjs --sdk-only && \
    PI_DEFAULT_CONFIG_DIR=/etc/pi PI_TEST_SCRIPTS_DIR=/opt/pi-app/scripts \
      node /opt/pi-app/scripts/test-runtime.mjs && \
    node /opt/pi-app/scripts/upstream-integrity.mjs /opt/pi-runtime && \
    python3 /opt/pi-app/tests/qwen-host-modes.test.py && \
    chmod 0755 /opt/pi-app/scripts/container-entrypoint.sh

ENV HOME=/home/pi \
    PI_CODING_AGENT_DIR=/home/pi/.pi/agent \
    PI_WEB_DATA_DIR=/home/pi/.pi-web \
    PI_WEB_CWD=/workspace \
    PI_WEB_HOST=0.0.0.0 \
    PI_WEB_PORT=8787
WORKDIR /workspace
ENTRYPOINT ["/opt/pi-app/scripts/container-entrypoint.sh"]
CMD ["pi-web-ui", "--no-browser"]
