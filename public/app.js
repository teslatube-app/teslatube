(function () {
  'use strict';
  var main = document.getElementById('main');
  var form = document.getElementById('searchform');
  var box = document.getElementById('searchbox');
  var longBox = document.getElementById('longonly');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function getJson(url, cb) {
    fetch(url).then(function (r) { return r.json(); }).then(function (j) { cb(null, j); })
      .catch(function (e) { cb(e); });
  }
  function fmtTime(s) {
    s = Math.max(0, Math.floor(s || 0));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return h > 0 ? h + ':' + p(m) + ':' + p(x) : m + ':' + p(x);
  }

  function showHint(t) { main.innerHTML = '<div class="hint">' + esc(t) + '</div>'; }
  function showError(t) { main.innerHTML = '<div class="error">' + esc(t) + '</div>'; }

  /* ---------- search results ---------- */
  function renderResults(q, data) {
    if (data.error) return showError('Search failed: ' + data.error);
    var rs = data.results || [];
    if (!rs.length) return showHint('No results for "' + q + '".');
    var html = '<div class="grid">';
    for (var i = 0; i < rs.length; i++) {
      var r = rs[i];
      html += '<a class="card" href="#/watch?v=' + encodeURIComponent(r.id) + '">' +
        '<div class="thumbwrap">' +
        (r.thumb ? '<img loading="lazy" src="' + esc(r.thumb) + '" alt="">' : '') +
        (r.duration ? '<span class="dur">' + esc(r.duration) + '</span>' : '') +
        '</div>' +
        '<div class="meta"><div class="title">' + esc(r.title) + '</div>' +
        '<div class="sub">' + esc(r.channel) +
        (r.views ? ' &middot; ' + esc(r.views) : '') +
        (r.published ? ' &middot; ' + esc(r.published) : '') +
        '</div></div></a>';
    }
    main.innerHTML = html + '</div>';
  }
  function doSearch(q) {
    showHint('Searching...');
    var url = '/api/search?q=' + encodeURIComponent(q);
    if (longBox.checked) url += '&long=1';
    getJson(url, function (err, data) {
      if (err) return showError('Search failed. Try again.');
      renderResults(q, data);
    });
  }

  /* ---------- watch view: frames only - pictures, not video. No embed fallback. ---------- */
  var activePlayer = null; // cleanup handle when navigating away

  function renderWatch(id) {
    if (activePlayer && activePlayer.stop) activePlayer.stop();
    activePlayer = null;
    main.innerHTML =
      '<div class="watch">' +
      '<div class="backbar"><a href="#/">&#8592; Back to search</a></div>' +
      '<div class="playerbox" id="playerbox"><div class="bufnote" id="bufnote">Loading player...</div></div>' +
      '<div class="controls" id="controls" style="display:none">' +
      '<button class="cbtn" id="playbtn" type="button">&#9654;</button>' +
      '<input class="seek" id="seek" type="range" min="0" max="1000" value="0">' +
      '<span class="time" id="time">0:00 / 0:00</span>' +
      '</div>' +
      '<div class="watchtitle" id="wtitle">Loading...</div>' +
      '<div class="watchchannel" id="wchannel"></div>' +
      '<div class="modenote" id="modenote"></div>' +
      '</div>';

    getJson('/api/info?id=' + encodeURIComponent(id), function (err, info) {
      if (err || !info || info.error) { document.getElementById('wtitle').textContent = 'Video ' + id; return; }
      document.getElementById('wtitle').textContent = info.title || '';
      document.getElementById('wchannel').textContent = info.channel || '';
    });

    var modenote = document.getElementById('modenote');

    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

    function showOffline(errMsg) {
      if (activePlayer && activePlayer.stop) activePlayer.stop();
      activePlayer = null;
      document.getElementById('controls').style.display = 'none';
      document.getElementById('playerbox').innerHTML =
        '<div class="bufnote">Frames engine offline right now.<br>' +
        '<span style="font-size:13px;opacity:.7">(' + esc(errMsg) + ')</span><br><br>' +
        '<button class="modetoggle" id="retrybtn" type="button">Try again</button></div>';
      modenote.textContent = 'TeslaTube plays pictures, not video embeds - the engine has to be reachable for playback.';
      document.getElementById('retrybtn').addEventListener('click', function () { startFrames(true); });
    }

    function startFrames(force) {
      document.getElementById('playerbox').innerHTML = '<div class="bufnote" id="bufnote">Starting frame engine...</div>';
      modenote.textContent = 'Frames mode: 360p frames + continuous audio, converted in short segments as you watch. No length cap - plays videos of any length.';
      startFramesPlayer(id, function (errMsg) { showOffline(errMsg); }, force);
    }

    startFrames(false);
  }

  /* ---------- the frames player ---------- */
  function startFramesPlayer(id, onFail, force) {
    var playerbox = document.getElementById('playerbox');
    var controls = document.getElementById('controls');
    var playbtn = document.getElementById('playbtn');
    var seek = document.getElementById('seek');
    var timeEl = document.getElementById('time');
    var stopped = false;

    getJson('/api/frames/' + id + '/start' + (force ? '?force=1' : ''), function (err2, job) {
      if (stopped) return;
      if (err2 || !job || !job.ok) {
        var m = (job && job.error) || 'could not start video';
        if (/ENOENT|not installed/i.test(m)) m = 'frame engine not installed on this server';
        return onFail(m);
      }

        // build player DOM
        playerbox.innerHTML = '<img class="frameimg" id="fimg" alt="">' +
          '<div class="bufnote" id="bufnote">Loading first segment (can take ~30s)...</div>';
        var fimg = document.getElementById('fimg');
        var bufnote = document.getElementById('bufnote');
        controls.style.display = 'flex';

        var audio = new Audio('/api/frames/' + id + '/audio');
        window.__ttAudio = audio;
        audio.preload = 'auto';
        var segs = {};     // n -> {ready, count, base, images, error}
        var curShown = -1;
        var seeking = false;

        function pad(n) { return ('0000' + n).slice(-5); }

        function loadSeg(n, cb) {
          var s = segs[n];
          if (s) { if (s.ready || s.error) return cb(s); s.waiters.push(cb); return; }
          s = segs[n] = { ready: false, error: null, waiters: [cb], images: [] };
          (function poll() {
            if (stopped) return;
            getJson('/api/frames/' + id + '/seg/' + n + '.json', function (e, d) {
              if (stopped) return;
              if (e || !d) { s.error = 'network'; return done(); }
              if (d.error) { s.error = d.error; return done(); }
              if (!d.ready) { setTimeout(poll, n === 0 ? 700 : 1500); return; }
              s.ready = true; s.count = d.count; s.base = d.base;
              for (var i = 0; i < d.count; i++) {
                var im = new Image();
                im.src = d.base + 'f_' + pad(i + 1) + '.jpg';
                s.images[i] = im;
              }
              done();
            });
          })();
          function done() {
            var w = s.waiters; s.waiters = [];
            for (var i = 0; i < w.length; i++) w[i](s);
          }
        }

        function showBuffering(msg) {
          bufnote.style.display = 'flex';
          bufnote.textContent = msg || 'Buffering...';
        }
        function hideBuffering() { bufnote.style.display = 'none'; }

        // prime segment 0
        loadSeg(0, function (s0) {
          if (stopped) return;
          if (s0.error) { showBuffering('Frame extraction failed: ' + s0.error); return; }
          hideBuffering();
        });

        playbtn.addEventListener('click', function () {
          if (audio.paused) { audio.play().catch(function () {}); } else { audio.pause(); }
        });
        audio.addEventListener('play', function () { playbtn.innerHTML = '&#10074;&#10074;'; });
        audio.addEventListener('pause', function () { playbtn.innerHTML = '&#9654;'; });
        audio.addEventListener('ended', function () { playbtn.innerHTML = '&#9654;'; });

        seek.addEventListener('input', function () {
          seeking = true;
          var t = (Number(seek.value) / 1000) * job.duration;
          timeEl.textContent = fmtTime(t) + ' / ' + fmtTime(job.duration);
        });
        seek.addEventListener('change', function () {
          audio.currentTime = (Number(seek.value) / 1000) * job.duration;
          curShown = -1;
          seeking = false;
        });

        // sync loop: frames follow the audio clock
        var timer = setInterval(function () {
          if (stopped) return;
          var t = audio.currentTime;
          if (!seeking) {
            seek.value = String(Math.round((t / job.duration) * 1000) || 0);
            timeEl.textContent = fmtTime(t) + ' / ' + fmtTime(job.duration);
          }
          var fl = job.firstLen || 0;
          var segN = fl && t < fl ? 0 : (fl ? 1 + Math.floor((t - fl) / job.segLen) : Math.floor(t / job.segLen));
          if (segN >= job.segCount) segN = job.segCount - 1;
          var segStartT = fl && segN > 0 ? fl + (segN - 1) * job.segLen : segN * job.segLen;
          var s = segs[segN];
          if (!s) {
            if (!audio.paused) { audio.pause(); showBuffering(); }
            loadSeg(segN, function (sn) { if (!sn.error) hideBuffering(); });
            return;
          }
          if (s.error) { showBuffering('Segment failed: ' + s.error); return; }
          if (!s.ready) {
            if (!audio.paused) { audio.pause(); showBuffering(); }
            return;
          }
          hideBuffering();
          var idx = Math.floor((t - segStartT) * job.fps);
          if (idx >= s.count) idx = s.count - 1;
          if (idx < 0) idx = 0;
          var im = s.images[idx];
          if (im && im.complete && idx !== curShown) {
            fimg.src = im.src;
            curShown = idx;
          }
          // look ahead
          var segEndT = fl && segN === 0 ? fl : segStartT + job.segLen;
          if (t > segEndT - 8 && segN + 1 < job.segCount) loadSeg(segN + 1, function () {});
        }, 120);

        activePlayer = {
          stop: function () {
            stopped = true;
            clearInterval(timer);
            try { audio.pause(); audio.src = ''; } catch (e) {}
          }
        };
      });
  }

  /* ---------- routing ---------- */
  function route() {
    var h = location.hash || '#/';
    var m = h.match(/^#\/watch\?v=([A-Za-z0-9_-]{11})/);
    if (m) return renderWatch(m[1]);
    if (activePlayer && activePlayer.stop) { activePlayer.stop(); activePlayer = null; }
    var q = h.match(/^#\/search\/(.+)$/);
    if (q) {
      var query = decodeURIComponent(q[1]);
      box.value = query;
      return doSearch(query);
    }
    showHint('Search for something to watch.');
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var q = box.value.trim();
    if (!q) return;
    location.hash = '#/search/' + encodeURIComponent(q);
    route();
  });
  longBox.addEventListener('change', function () {
    if ((location.hash || '').match(/^#\/search\//)) route();
  });
  window.addEventListener('hashchange', route);
  route();
})();
