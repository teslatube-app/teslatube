# TeslaTube

David's personal YouTube app for his 2017 Tesla (MCU2 browser). YouTube-only,
dark theme, big touch targets, minimal JS (old-Chromium safe).

## The point
teslaplay.net caps videos at 20 minutes. TeslaTube has no length cap anywhere.

## Architecture
- `server.js` - zero-dependency Node server: static frontend, YouTube search
  scrape (`/api/search`, no API key), oEmbed info (`/api/info`), Car-mode
  proxy (`/api/stream`).
- `frames.js` - the frame engine (David's spec): resolves each video once with
  yt-dlp (`youtube:player_client=android` - the only client whose stream URLs
  are fetchable from a datacenter IP in 2026), then ffmpeg pulls 30-second
  frame segments on demand (5 fps JPEG, 640x360, ~10KB/frame) while the player
  preloads one segment ahead. Old segments are deleted (rolling window), jobs
  expire after 30 idle minutes. Audio = the same 360p mp4 proxied with HTTP
  range support, and the player syncs frames to the audio clock.
- Player mode: **Frames only** - David's spec is pictures, not a video embed.
  There is no iframe mode; when the engine is unreachable the app says so and
  offers a retry.

## Limits (free Render)
- Source quality is 360p (only muxed format YouTube gives a datacenter IP
  without sign-in).
- ~0.27 GB per viewing-hour (frames ~0.18 + audio ~0.09) -> the 5 GB/month
  free bandwidth sustains roughly 18 hours/month.
- Free service sleeps after 15 idle minutes (~1 min cold start).
- If YouTube starts blocking Render's IPs, run the same server on David's Mac
  (residential IP) and expose it with `cloudflared tunnel --url
  http://localhost:3000` - unlimited bandwidth, same code.

## Run
Needs Node 18+, yt-dlp, ffmpeg.
```
node server.js   # PORT env var supported
```

## Update / maintain
- Deploys from git: push changes, Render rebuilds automatically (or Manual
  Deploy in the dashboard).
- If search or playback breaks, YouTube changed something: check `yt-dlp -U`
  first, then test `/api/search?q=test` and `/api/frames/status` on the live
  service. Render dashboard -> Logs shows extraction errors verbatim.

## Run on your own server (Docker)

The whole app - frontend + frames engine + yt-dlp + ffmpeg - ships in one container.

```bash
git clone https://github.com/teslatube-app/teslatube.git
cd teslatube
docker compose up -d
```

Then open http://YOUR-SERVER-IP:3000 (in the Tesla browser: http://YOUR-SERVER-IP:3000).

First-run check - does YouTube accept your server's IP for frames mode?

```bash
curl http://localhost:3000/api/selftest
```

`"ipAccepted": true` = frames mode (any length video) will work. `false` = YouTube refuses that IP; playback will not work from this server.

Tunables (docker-compose.yml `environment:`):
- `PORT` - container port (default 3000; change the left side of `ports:` for the host port)
- `YTDLP_CLIENT` - yt-dlp player client (default `android`)
- `FIRST_SEG_LEN` - first segment length in seconds (default 8, so playback starts in a few seconds; later segments are 30s)

Update later: `git pull && docker compose up -d --build`
