#!/bin/bash
# Render build: fetch static yt-dlp + ffmpeg into ./bin (free native Node env has neither)
set -e
mkdir -p bin
cd bin
if [ ! -x yt-dlp ]; then
  curl -sSL -o yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux
  chmod +x yt-dlp
fi
if [ ! -x ffmpeg ]; then
  curl -sSL -o ffmpeg.tar.xz https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
  tar -xf ffmpeg.tar.xz --strip-components=1 --wildcards '*/ffmpeg' '*/ffprobe'
  chmod +x ffmpeg ffprobe
  rm -f ffmpeg.tar.xz
fi
