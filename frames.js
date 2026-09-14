'use strict';
/*
 * Frame engine: segmented on-the-fly frame extraction (David's spec).
 * One yt-dlp resolve per video (android player client - the only client
 * whose URLs are fetchable from a datacenter IP in 2026), giving a
 * progressive 360p mp4 (itag 18, video+audio). ffmpeg pulls 30s frame
 * segments on demand at 5 fps; audio is the same mp4 proxied with range.
 * Rolling window: old segments deleted; jobs expire after 30 idle min.
 * Runs anywhere Node + yt-dlp + ffmpeg exist (Render free or David's Mac).
 */
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

const FPS = 5;
const SEG_LEN = 30;
const FRAMES_PER_SEG = FPS * SEG_LEN;
const JPEG_Q = 6;
const KEEP_BEHIND = 1;
const JOB_IDLE_MS = 30 * 60 * 1000;
const TMP = process.env.FRAMES_TMP || '/tmp/teslatube-frames';
const ANDROID_UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip';

const jobs = new Map();

function sh(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs || 60000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(cmd + ' failed: ' + (stderr || err.message).toString().slice(0, 300)));
      resolve(stdout.toString());
    });
  });
}
function whichOk(cmd, args) {
  return sh(cmd, args, 10000).then(() => true).catch(() => false);
}
async function engineStatus() {
  const [yd, ff] = await Promise.all([whichOk('yt-dlp', ['--version']), whichOk('ffmpeg', ['-version'])]);
  return { available: yd && ff, ytDlp: yd, ffmpeg: ff, fps: FPS, segLen: SEG_LEN };
}

async function startJob(videoId) {
  let job = jobs.get(videoId);
  if (job) { job.lastTouch = Date.now(); return job; }
  const out = await sh('yt-dlp', [
    '--no-playlist', '--no-warnings',
    '--extractor-args', 'youtube:player_client=android',
    '-J', 'https://www.youtube.com/watch?v=' + videoId
  ], 90000);
  const j = JSON.parse(out);
  const f = (j.formats || []).find(x => x.format_id === '18' && x.url);
  if (!f) throw new Error('no progressive 360p format (YouTube may be blocking this server IP)');
  if (!j.duration) throw new Error('live streams are not supported in frames mode');
  const dir = path.join(TMP, videoId);
  fs.mkdirSync(dir, { recursive: true });
  job = {
    id: videoId, title: j.title || '', duration: j.duration,
    url: f.url,
    fps: FPS, segLen: SEG_LEN, framesPerSeg: FRAMES_PER_SEG,
    segCount: Math.ceil(j.duration / SEG_LEN),
    dir: dir, segs: {}, lastTouch: Date.now()
  };
  jobs.set(videoId, job);
  return job;
}

function ensureSeg(job, n, isPrefetch) {
  if (n < 0 || n >= job.segCount) throw new Error('segment out of range');
  job.lastTouch = Date.now();
  const seg = job.segs[n] || (job.segs[n] = { status: 'pending', count: 0 });
  if (seg.status === 'pending') {
    seg.status = 'working';
    const segDir = path.join(job.dir, 'seg' + n);
    fs.mkdirSync(segDir, { recursive: true });
    const p = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-headers', 'User-Agent: ' + ANDROID_UA + '\r\n',
      '-ss', String(n * SEG_LEN), '-t', String(SEG_LEN),
      '-i', job.url,
      '-vf', 'fps=' + FPS,
      '-q:v', String(JPEG_Q),
      path.join(segDir, 'f_%05d.jpg')
    ], { timeout: 120000 });
    let errBuf = '';
    p.stderr.on('data', d => { errBuf += d.toString(); });
    p.on('close', code => {
      let files = [];
      try { files = fs.readdirSync(segDir).filter(f => f.endsWith('.jpg')).sort(); } catch (e) {}
      if (code === 0 && files.length) {
        seg.status = 'ready'; seg.count = files.length; seg.files = files;
      } else {
        seg.status = 'error';
        seg.error = ('ffmpeg exit ' + code + ': ' + errBuf.slice(-200)) || 'no frames';
      }
    });
    p.on('error', e => { seg.status = 'error'; seg.error = String(e.message || e); });
  }
  for (const k in job.segs) {
    const kn = Number(k);
    if (kn < n - KEEP_BEHIND && job.segs[k].status !== 'working') {
      try { fs.rmSync(path.join(job.dir, 'seg' + kn), { recursive: true, force: true }); } catch (e) {}
      delete job.segs[k];
    }
  }
  if (!isPrefetch) {
    for (let a = 1; a <= 2; a++) {
      if (n + a < job.segCount && !job.segs[n + a]) {
        setImmediate(() => { try { ensureSeg(job, n + a, true); } catch (e) {} });
      }
    }
  }
  return seg;
}

function proxyUrl(req, res, urlStr, extraHeaders) {
  let u;
  try { u = new URL(urlStr); } catch (e) { res.writeHead(502); return res.end('bad url'); }
  const headers = Object.assign({ 'User-Agent': ANDROID_UA }, extraHeaders || {});
  if (req.headers.range) headers['Range'] = req.headers.range;
  const up = https.request({ hostname: u.hostname, path: u.pathname + u.search, headers: headers, timeout: 20000 }, upRes => {
    const h = {
      'Content-Type': upRes.headers['content-type'] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*'
    };
    ['content-length', 'content-range'].forEach(k => { if (upRes.headers[k]) h[k.replace(/(^|-)(\w)/g, (m, a, b) => a + b.toUpperCase())] = upRes.headers[k]; });
    res.writeHead(upRes.statusCode === 206 ? 206 : 200, h);
    upRes.pipe(res);
    req.on('close', () => upRes.destroy());
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  up.on('timeout', () => up.destroy());
  up.end();
}

async function handle(req, res, u, sendJson) {
  const p = u.pathname;

  if (p === '/api/frames/status') {
    sendJson(res, 200, await engineStatus());
    return true;
  }

  let m = p.match(/^\/api\/frames\/([A-Za-z0-9_-]{11})\/start$/);
  if (m) {
    try {
      const job = await startJob(m[1]);
      sendJson(res, 200, {
        ok: true, id: job.id, title: job.title, duration: job.duration,
        fps: job.fps, segLen: job.segLen, framesPerSeg: job.framesPerSeg, segCount: job.segCount
      });
    } catch (e) { sendJson(res, 200, { ok: false, error: String(e.message || e) }); }
    return true;
  }

  m = p.match(/^\/api\/frames\/([A-Za-z0-9_-]{11})\/seg\/(\d+)\.json$/);
  if (m) {
    try {
      const job = await startJob(m[1]);
      const seg = ensureSeg(job, Number(m[2]));
      if (seg.status === 'ready') {
        sendJson(res, 200, { ready: true, seg: Number(m[2]), count: seg.count, base: '/api/frames/' + job.id + '/seg/' + m[2] + '/' });
      } else if (seg.status === 'error') {
        sendJson(res, 200, { ready: false, error: seg.error || 'extraction failed' });
      } else {
        sendJson(res, 200, { ready: false });
      }
    } catch (e) { sendJson(res, 200, { ready: false, error: String(e.message || e) }); }
    return true;
  }

  m = p.match(/^\/api\/frames\/([A-Za-z0-9_-]{11})\/seg\/(\d+)\/(f_\d+\.jpg)$/);
  if (m) {
    const fp = path.join(TMP, m[1], 'seg' + m[2], m[3]);
    if (!fs.existsSync(fp)) { res.writeHead(404); res.end(); return true; }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' });
    fs.createReadStream(fp).pipe(res);
    return true;
  }

  m = p.match(/^\/api\/frames\/([A-Za-z0-9_-]{11})\/audio$/);
  if (m) {
    try {
      const job = await startJob(m[1]);
      proxyUrl(req, res, job.url);
    } catch (e) { sendJson(res, 502, { error: String(e.message || e) }); }
    return true;
  }

  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.lastTouch > JOB_IDLE_MS) {
      try { fs.rmSync(job.dir, { recursive: true, force: true }); } catch (e) {}
      jobs.delete(id);
    }
  }
}, 60000).unref();

module.exports = { handle, startJob, proxyUrl };
