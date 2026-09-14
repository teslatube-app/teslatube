'use strict';
/*
 * TeslaTube - personal YouTube app for the Tesla MCU2 browser.
 * Zero-dependency Node server:
 *   - static, low-JS frontend (old-Chromium safe)
 *   - /api/search        : scrapes YouTube search (no API key)
 *   - /api/info          : title/channel via YouTube oEmbed
 *   - /api/frames/*      : segmented frame engine (see frames.js) - David's spec
 *   - /api/stream(-check): Car mode, proxies progressive 360p MP4 via yt-dlp
 *   - /healthz           : host health checks
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const frames = require('./frames');

// Prefer locally downloaded static binaries (Render build fetches them into ./bin)
process.env.PATH = path.join(__dirname, 'bin') + ':' + process.env.PATH;

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

/* ---------- tiny fetch helper (redirect-following, buffered) ---------- */
function fetchBuf(urlStr, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
      timeout: opts.timeout || 20000
    }, res => {
      if ([301, 302, 303, 307, 308].indexOf(res.statusCode) !== -1 && res.headers.location && (opts._redir || 0) < 5) {
        res.resume();
        const next = new URL(res.headers.location, urlStr).toString();
        resolve(fetchBuf(next, Object.assign({}, opts, { _redir: (opts._redir || 0) + 1 })));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/* ---------- YouTube search scraping ---------- */
function extractJsonVar(html, varName) {
  const i = html.indexOf(varName);
  if (i === -1) return null;
  const start = html.indexOf('{', i);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(html.slice(start, j + 1)); } catch (e) { return null; } } }
    }
  }
  return null;
}

function collectVideoRenderers(node, out) {
  if (!node || typeof node !== 'object') return;
  if (node.videoRenderer && node.videoRenderer.videoId && node.videoRenderer.title) {
    out.push(node.videoRenderer);
    return;
  }
  for (const k in node) {
    if (Object.prototype.hasOwnProperty.call(node, k)) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach(x => collectVideoRenderers(x, out));
      else if (v && typeof v === 'object') collectVideoRenderers(v, out);
    }
  }
}

function runsText(runs) {
  if (!runs) return '';
  if (typeof runs.simpleText === 'string') return runs.simpleText;
  if (Array.isArray(runs.runs)) return runs.runs.map(r => r.text || '').join('');
  return '';
}

function shapeResults(renderers) {
  const seen = {};
  const out = [];
  for (const r of renderers) {
    const id = r.videoId;
    if (!id || seen[id]) continue;
    const dur = r.lengthText ? runsText(r.lengthText) : '';
    const title = runsText(r.title);
    if (!title) continue;
    seen[id] = true;
    let thumb = '';
    if (r.thumbnail && Array.isArray(r.thumbnail.thumbnails) && r.thumbnail.thumbnails.length) {
      const ts = r.thumbnail.thumbnails;
      thumb = (ts.find(t => t.width >= 320) || ts[ts.length - 1]).url;
    }
    out.push({
      id: id, title: title,
      channel: runsText(r.ownerText) || runsText(r.shortBylineText),
      duration: dur,
      views: r.viewCountText ? runsText(r.viewCountText) : '',
      published: r.publishedTimeText ? runsText(r.publishedTimeText) : '',
      thumb: thumb
    });
  }
  return out;
}

let innertubeKeyCache = null;
async function getInnertubeKey() {
  if (innertubeKeyCache) return innertubeKeyCache;
  try {
    const r = await fetchBuf('https://www.youtube.com/', { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', 'Cookie': 'CONSENT=YES+cb.20220419-08-p0.en+FX+111; SOCS=CAI' } });
    const m = r.body.toString('utf8').match(/"INNERTUBE_API_KEY":"([^"]+)"/);
    if (m) { innertubeKeyCache = m[1]; return innertubeKeyCache; }
  } catch (e) {}
  return null; // no hardcoded fallback key; scrape failure just disables the innertube retry path
}

async function ytSearch(q, longOnly) {
  let u = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q);
  if (longOnly) u += '&sp=' + encodeURIComponent('EgIYAg=='); // filter: duration > 20 minutes
  const r = await fetchBuf(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', 'Cookie': 'CONSENT=YES+cb.20220419-08-p0.en+FX+111; SOCS=CAI' } });
  const data = extractJsonVar(r.body.toString('utf8'), 'ytInitialData');
  const renderers = [];
  if (data) collectVideoRenderers(data, renderers);
  let results = shapeResults(renderers);
  if (results.length === 0) {
    const key = await getInnertubeKey();
    if (!key) return results;
    const body = JSON.stringify({
      context: { client: { clientName: 'WEB', clientVersion: '2.20240726.00.00', hl: 'en', gl: 'US' } },
      query: q
    });
    const r2 = await fetchBuf('https://www.youtube.com/youtubei/v1/search?key=' + key + '&prettyPrint=false', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body: body
    });
    try {
      const rr = [];
      collectVideoRenderers(JSON.parse(r2.body.toString('utf8')), rr);
      results = shapeResults(rr);
    } catch (e) {}
  }
  return results;
}

/* ---------- oEmbed info ---------- */
async function ytInfo(id) {
  const r = await fetchBuf('https://www.youtube.com/oembed?url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id) + '&format=json', { headers: { 'User-Agent': UA } });
  if (r.status !== 200) throw new Error('oEmbed status ' + r.status);
  const j = JSON.parse(r.body.toString('utf8'));
  return { title: j.title || '', channel: j.author_name || '', thumb: j.thumbnail_url || '' };
}

/* ---------- static + routing ---------- */
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;

    if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }

    if (p === '/api/search') {
      const q = (u.searchParams.get('q') || '').trim();
      if (!q) return sendJson(res, 400, { error: 'missing q' });
      ytSearch(q, u.searchParams.get('long') === '1')
        .then(results => sendJson(res, 200, { results: results }))
        .catch(e => sendJson(res, 502, { error: String(e && e.message || e) }));
      return;
    }

    if (p === '/api/info') {
      const id = (u.searchParams.get('id') || '').trim();
      if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return sendJson(res, 400, { error: 'bad id' });
      ytInfo(id)
        .then(info => sendJson(res, 200, info))
        .catch(e => sendJson(res, 502, { error: String(e && e.message || e) }));
      return;
    }

    if (p === '/api/stream-check') {
      const id = (u.searchParams.get('id') || '').trim();
      if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return sendJson(res, 400, { error: 'bad id' });
      try {
        const job = await frames.startJob(id);
        sendJson(res, 200, { ok: true, quality: '360p', lengthSeconds: job.duration });
      } catch (e) { sendJson(res, 200, { ok: false, error: String(e.message || e) }); }
      return;
    }

    if (p === '/api/stream') {
      const id = (u.searchParams.get('id') || '').trim();
      if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return sendJson(res, 400, { error: 'bad id' });
      try {
        const job = await frames.startJob(id);
        frames.proxyUrl(req, res, job.url);
      } catch (e) { sendJson(res, 404, { error: String(e.message || e) }); }
      return;
    }

    if (await frames.handle(req, res, u, sendJson)) return;

    // static files; SPA fallback to index.html
    let fp = p === '/' ? '/index.html' : p;
    let full = path.normalize(path.join(PUBLIC_DIR, fp));
    if (full.indexOf(PUBLIC_DIR) !== 0) { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) full = path.join(PUBLIC_DIR, 'index.html');
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: String(e && e.message || e) });
    else res.end();
  }
});

server.listen(PORT, () => console.log('TeslaTube listening on :' + PORT));
