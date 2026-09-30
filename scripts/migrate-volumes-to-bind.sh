#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."

mkdir -p data/pi data/web

copy_volume() {
  local volume="$1" dest="$2"
  if ! docker volume inspect "$volume" >/dev/null 2>&1; then
    echo "Skip: Docker volume $volume does not exist"
    return 0
  fi
  echo "Migrating $volume -> $dest"
  docker run --rm \
    -v "$volume:/from:ro" \
    -v "$(realpath "$dest"):/to" \
    alpine:3.22 sh -c 'cp -a /from/. /to/'
}

# Stop Pi before copying so the state is consistent.
docker compose down 2>/dev/null || true
copy_volume pi-docker_pi_data data/pi
copy_volume pi-docker_pi_web_data data/web

# Container user is UID/GID 1000 in this image. On a typical desktop this is
# already the host user; only root can repair ownership when needed.
if [[ $(id -u) -eq 0 ]]; then
  chown -R 1000:1000 data/pi data/web
fi

echo
echo "Migration complete. Inspect data/pi and data/web, then start with:"
echo "  docker compose up -d --build"
echo
echo "The old named volumes were NOT deleted. After verification you may remove them with:"
echo "  docker volume rm pi-docker_pi_data pi-docker_pi_web_data"
