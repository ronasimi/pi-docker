# Pi Docker

Standalone containerized Pi + `pi-web-ui` project. It does **not** run Ollama or the MCP services itself.

## Architecture

```text
Browser :8787
     |
     v
Pi + pi-web-ui container
     |-- host.docker.internal:11434 --> existing Ollama container
     `-- ai-local -------------------> mcp-gateway container
                                       |-- SearXNG MCP :8888
                                       `-- Playwright MCP :8931
```

## What this repo does

- Runs Pi and `pi-web-ui` entirely in Docker.
- Publishes the UI only on `127.0.0.1:8787` by default.
- Mounts `~/Projects` at `/workspace`.
- Persists Pi sessions/settings in a Docker volume.
- Persists Web UI state in a separate Docker volume.
- Connects to the already-running Ollama server through `host.docker.internal:11434`.
- Uses 64K Ollama aliases for the two Gemma 4 QAT models.
- Connects to the separate `mcp-gateway` container through the external `ai-local` network.
- Keeps MCP tools proxy-only (`directTools: false`) to avoid prompt-schema bloat.
- Installs `pi-mcp-adapter` into the persistent Pi volume on first boot.

## Requirements

- Docker Engine + Compose plugin
- Existing Ollama container publishing host port `11434`
- These source models already pulled in Ollama:
  - `gemma4:e2b-it-qat`
  - `gemma4:e4b-it-qat`
- `~/Projects/mcp-gateway` is optional but expected for MCP search/browser tools.

## First start

```bash
cd ~/Projects/pi-docker
./scripts/init.sh
```

The init script:

1. creates `.env` from `.env.example` if necessary;
2. copies the MCP token from adjacent `../mcp-gateway/.env` when available;
3. creates the external `ai-local` Docker network if missing;
4. creates lightweight Ollama aliases with `num_ctx=65536`;
5. builds and starts the Pi/Web UI container.

Open:

```text
http://127.0.0.1:8787
```

## Why the `-64k` model aliases exist

Pi's `contextWindow: 65536` is metadata used for its own budgeting. The OpenAI-compatible Ollama API has no request field for changing the runtime context size. Ollama therefore needs a model created with `PARAMETER num_ctx 65536` as well. The aliases created by `scripts/configure-ollama-64k.sh` ensure both layers agree.

The aliases reuse the existing model layers; they do not make another full 4.3/6.1 GB copy of the weights.

Pi models:

- `ollama/gemma4:e2b-it-qat-64k`
- `ollama/gemma4:e4b-it-qat-64k`

Both are configured for text + image input and thinking support.

## MCP

The repo installs `pi-mcp-adapter` on first boot and reads `config/mcp.json` from the container-global MCP config path.

Configured endpoints:

- `http://mcp-gateway:8888/mcp/` — SearXNG
- `http://mcp-gateway:8931/mcp` — Playwright

Both use `directTools: false`. Pi sees the small generic `mcp`/`mcpScript` gateway instead of injecting every MCP schema into every model request.

If `mcp-gateway` is not running, Pi still starts because the MCP servers are lazy.

## Useful commands

```bash
# Start/rebuild
docker compose up -d --build

# Logs
docker compose logs -f pi

# Status/connectivity
./scripts/status.sh

# Open a Pi CLI in the same persistent configuration
docker compose exec pi pi

# Shell
docker compose exec pi bash

# Stop
docker compose down
```

## Update Pi or the Web UI

Edit `.env` and rebuild. For example:

```text
PI_VERSION=latest
PI_WEB_UI_VERSION=0.96.1
```

Then:

```bash
docker compose build --pull --no-cache
docker compose up -d
```

`pi-web-ui` embeds its own Pi SDK, so update the Web UI package itself when you want its SDK updated too.

## Reset container state

Stop first:

```bash
docker compose down
```

Remove only Pi/Web UI state (does not touch Ollama models or the MCP repo):

```bash
docker volume rm pi-docker_pi_data pi-docker_pi_web_data
```

Then rerun `./scripts/init.sh`.
