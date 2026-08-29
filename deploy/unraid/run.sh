#!/bin/sh
# Rawe Ceek on Unraid without the Compose plugin: plain docker run.
# Re-running this script is safe; it recreates both containers.
#
#   curl -fsSL https://raw.githubusercontent.com/tronzop/Rawe-Ceek/main/deploy/unraid/run.sh | sh
set -eu

APP=/mnt/user/appdata/rawe-ceek
PORT=${PORT:-3732}
IMAGE=ghcr.io/tronzop/rawe-ceek:latest

mkdir -p "$APP/data" "$APP/assets/clips" "$APP/assets/drivers" "$APP/assets/engine"

docker pull "$IMAGE"
docker rm -f rawe-ceek >/dev/null 2>&1 || true
docker run -d --name rawe-ceek \
  --restart unless-stopped \
  -p "$PORT:8080" \
  -e PORT=8080 -e LEADERBOARD_FILE=/data/leaderboard.json -e TZ=America/New_York \
  -v "$APP/data:/data" \
  -v "$APP/assets/clips:/app/assets/clips" \
  -v "$APP/assets/drivers:/app/assets/drivers" \
  -v "$APP/assets/engine:/app/assets/engine" \
  -l com.centurylinklabs.watchtower.enable=true \
  -l net.unraid.docker.webui="http://[IP]:[PORT:$PORT]/" \
  -l net.unraid.docker.icon=https://raw.githubusercontent.com/tronzop/Rawe-Ceek/main/assets/favicon.png \
  "$IMAGE"

# Watchtower: only touches containers carrying the enable label; checks GHCR every 5 minutes.
docker rm -f rawe-ceek-watchtower >/dev/null 2>&1 || true
docker run -d --name rawe-ceek-watchtower \
  --restart unless-stopped \
  -e DOCKER_API_VERSION=1.44 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -l net.unraid.docker.icon=https://containrrr.dev/watchtower/assets/logo-450x450.png \
  containrrr/watchtower:latest --label-enable --cleanup --interval 300

echo "Rawe Ceek: http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT"
