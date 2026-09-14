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
- Player modes: **Frames** (default, his spec) and **Embed** (YouTube iframe
  fallback - free, unlimited, 720p+ when the Tesla browser allows it).

## Limits (free Render)
- Source quality for frames/car mode is 360p (only muxed format YouTube gives
  a datacenter IP without sign-in). Embed mode can do 720p+.
- ~0.27 GB per viewing-hour (frames ~0.18 + audio ~0.09) -> the 5 GB/month
  free bandwidth sustains roughly 18 hours/month. Embed mode uses ~nothing.
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
