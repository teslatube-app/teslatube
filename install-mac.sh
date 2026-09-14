#!/bin/bash
# TeslaTube frame engine - one-command Mac setup for David.
# Installs deps (brew, yt-dlp, ffmpeg, cloudflared), starts the server,
# and opens a free public tunnel the Tesla browser can reach.
set -e
cd "$(dirname "$0")"
command -v brew >/dev/null || { echo "Installing Homebrew first - you'll be asked for your Mac password:"; /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"; }
for dep in yt-dlp ffmpeg cloudflared node; do
  command -v "$dep" >/dev/null || brew install "$dep"
done
node server.js &
SERVER_PID=$!
sleep 2
echo "Server running (pid $SERVER_PID). Starting public tunnel..."
echo "Look for a https://....trycloudflare.com URL below - THAT is the address to open in the Tesla."
cloudflared tunnel --url http://localhost:3000
kill $SERVER_PID 2>/dev/null
