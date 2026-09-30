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
                                       |-- Playwright MCP :8931
                                       `-- Memory MCP :8932
```

## Repository state layout

```text
pi-docker/
├── config/          # version-controlled provider/MCP configuration
├── data/
│   ├── pi/          # durable Pi settings, packages, sessions
│   └── web/         # durable pi-web-ui state
└── scripts/
```

## What this repo does

- Runs Pi and `pi-web-ui` entirely in Docker.
- Publishes the UI only on `127.0.0.1:8787` by default.
- Mounts `~/Projects` at `/workspace`.
- Persists Pi sessions/settings in the host-visible `./data/pi/` bind mount.
- Persists Web UI state in the host-visible `./data/web/` bind mount.
- Connects to the already-running Ollama server through `host.docker.internal:11434`.
- Uses 64K Ollama aliases for the two Gemma 4 QAT models.
- Connects to the separate `mcp-gateway` container through the external `ai-local` network.
- Keeps MCP tools proxy-only (`directTools: false`) to avoid prompt-schema bloat.
- Mounts a short global `APPEND_SYSTEM.md` that makes MCP discovery the first route for live web, browser, and durable-memory tasks.
- Installs `pi-mcp-adapter` into the persistent Pi volume on first boot.

## Requirements

- Docker Engine + Compose plugin
- Existing Ollama container publishing host port `11434`
- These source models already pulled in Ollama:
  - `gemma4:e2b-it-qat`
  - `gemma4:e4b-it-qat`
- `~/Projects/mcp-gateway` is optional but expected for MCP search/browser/memory tools.

## First start

```bash
cd ~/Projects/pi-docker
./scripts/init.sh
```

The init script:

1. creates `.env` from `.env.example` if necessary;
2. ensures the shared `ai-local` Docker network exists;
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

The two `-64k` Gemma aliases are created automatically when their source models are present. They are then discovered like every other installed Ollama model.

## MCP

The repo installs `pi-mcp-adapter` on first boot and reads `config/mcp.json` from the container-global MCP config path.

Configured endpoints:

- `http://mcp-gateway:8888/mcp/` — SearXNG
- `http://mcp-gateway:8931/mcp` — Playwright
- `http://mcp-gateway:8932/mcp` — Memory

All three use `directTools: false`. Pi sees the small generic `mcp`/`mcpScript` gateway instead of injecting every MCP schema into every model request.

The repo also mounts `config/APPEND_SYSTEM.md` at `~/.pi/agent/APPEND_SYSTEM.md`. It tells the model to check MCP before shell/network fallbacks for live web, public browser, and memory tasks. This preserves Pi's normal system prompt and only appends routing policy. Restart/recreate the Pi session after changing it so the new prompt is loaded.

With MCP gateway v10, Pi uses the trusted `ai-local` endpoints directly. The private upstream SearXNG container is not host-published and does not need a separate application-level API key.

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

## Container user

The image reuses the UID/GID 1000 account already provided by the official Node image, renaming `node:node` to `pi:pi` and moving its home to `/home/pi`. This avoids UID/GID collisions while keeping bind-mounted files owned by the normal desktop user on typical Linux installations.

## Persistent state

Pi and Web UI state are ordinary host directories:

```text
data/pi/   -> /home/pi/.pi
data/web/  -> /home/pi/.pi-web
```

They survive container recreation and image rebuilds and can be inspected or backed up directly. Runtime contents are ignored by Git.

### Migrating an older named-volume installation

If you already used the previous repo version, run this **before** starting the bind-mount version:

```bash
./scripts/migrate-volumes-to-bind.sh
```

The script copies `pi-docker_pi_data` and `pi-docker_pi_web_data` into `data/pi/` and `data/web/` but deliberately leaves the old volumes intact until you verify the new container.

### Reset container state

```bash
docker compose down
rm -rf data/pi/* data/web/*
mkdir -p data/pi/agent data/web
./scripts/init.sh
```

This does not touch Ollama models or the MCP gateway repo.

## Restart-loop protection

Container startup treats Ollama discovery and first-boot MCP adapter installation as recoverable. A transient Ollama/npm failure no longer exits PID 1 and triggers `restart: unless-stopped`; the Web UI starts with the last known-good model catalog, or the bundled two-Gemma fallback on first boot.

For startup diagnostics:

```bash
./scripts/logs.sh
```

It prints Docker restart/exit state and the last 200 Pi log lines.

## Automatic Ollama model discovery

Pi no longer has a static model list. On every `pi` container start, `scripts/sync-ollama-models.mjs` reads Ollama's `/api/tags`, optionally enriches incomplete entries with `/api/show`, and atomically regenerates:

```text
data/pi/agent/models.json
```

All installed Ollama models are listed. Native context is capped by `PI_OLLAMA_CONTEXT_CAP` (default 65536) to avoid accidentally requesting oversized contexts on local hardware. Vision and thinking flags are inferred from Ollama capabilities. Per-model metadata can be overridden in `config/models-overrides.json`.

After pulling a new model, restart Pi to refresh the selector:

```bash
docker exec ollama ollama pull <model>
cd ~/Projects/pi-docker
docker compose restart pi
```

Or regenerate the catalog explicitly with `./scripts/sync-models.sh` and then restart Pi if the UI was already running.
