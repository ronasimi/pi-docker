FROM node:22-bookworm-slim

ARG PI_VERSION=latest
ARG PI_WEB_UI_VERSION=0.96.1

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      bash ca-certificates curl git jq openssh-client ripgrep \
      python3 make g++ && \
    npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" && \
    npm install -g "pi-web-ui@${PI_WEB_UI_VERSION}" && \
    rm -rf /root/.npm /var/lib/apt/lists/*

# Run as an unprivileged user so files created under /workspace are not root-owned
# on a typical single-user Linux desktop (UID/GID 1000).
RUN groupadd --gid 1000 pi && \
    useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash pi && \
    mkdir -p /workspace /home/pi/.pi/agent /home/pi/.pi-web /home/pi/.config/mcp && \
    chown -R pi:pi /workspace /home/pi

COPY --chown=pi:pi scripts/container-entrypoint.sh /usr/local/bin/pi-container-entrypoint
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
