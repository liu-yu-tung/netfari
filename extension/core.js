// SPDX-License-Identifier: GPL-3.0-or-later
// Shared part, runs in the page's own JS world (injected by content.js before
// one file from sites/). A site file calls __netfariCore.register(site) with:
//   name                    'netflix', 'disney', ...
//   install(core)           add the hooks that find subtitle tracks; report them
//                           with core.setTracks(movieKey, tracks)
//   movieKey()              key of the title playing now, or null
//   missingMessage(lang, n) status text when `lang` is not in a list of n tracks
//   playerView(video)       optional: element that exactly covers the video
//   shadowVideos            optional: also look for <video> inside shadow DOM
//   timeOffset(video)       optional: seconds to add to video.currentTime to get
//                           the time the subtitle files use
//   chooseTrack(tracks, lang) optional: pick among usable tracks of one language
//   selectionKey()          optional: changes when the player's audio or subtitle
//                           choice changes, so the track choice is redone
// A track is { lang, label, kind: 'subtitles'|'closedcaptions'|..., forced,
// format: 'webvtt-...'|'dfxp-...'|'hls-webvtt'|..., urls: [...] }.
(() => {
  if (window.__netfariCore) return;
  // Safari before 18 ignores "world": "MAIN" and would run this file in the
  // content-script world, where the hooks see nothing; content.js injects it then.
  if (globalThis.browser?.runtime?.id || globalThis.chrome?.runtime?.id) return;
  // Tells content.js that the page-world copy is already running.
  document.documentElement.setAttribute('data-netfari', '');
  // 'manifest' = started by Safari before the site's scripts; 'injected' = by content.js.
  const loadedBy = document.currentScript ? 'injected' : 'manifest';

  const MSG = '__netfari';
  const LS_KEY = 'netfari.settings';
  const HLS = 'hls-webvtt';
  const DEFAULTS = { enabled: true, lang: '', position: 7, size: 4.5, lineHeight: 1.25 };

  // Site files may wrap these; keep the originals for our own use.
  const origParse = JSON.parse;
  const origStringify = JSON.stringify;
  const origFetch = window.fetch;

  let site = null;
  let settings = normalize(readLocal());
  const tracksByMovie = new Map(); // movie key -> track list
  const cueCache = new Map(); // url -> Promise<cues>
  let cues = [];
  let activeKey = '';
  let status = '';
  let lastPath = '';
  // For debug(): what happened while loading and drawing.
  const diag = { renders: 0, renderError: '', version: '' };

  function readLocal() {
    try {
      return origParse(localStorage.getItem(LS_KEY) || '{}');
    } catch {
      return {};
    }
  }

  // position: 0 = top edge of the video, 100 = bottom edge.
  // Older versions stored 'top' or 'bottom'.
  function normalize(s) {
    const out = { ...DEFAULTS, ...s };
    if (out.position === 'top') out.position = 7;
    else if (out.position === 'bottom') out.position = 80;
    out.position = Math.min(100, Math.max(0, Number(out.position) || 0));
    out.lineHeight = Number(out.lineHeight) || DEFAULTS.lineHeight;
    return out;
  }

  function writeLocal() {
    try {
      localStorage.setItem(LS_KEY, origStringify(settings));
    } catch {}
  }

  // ---------- track choice and loading ----------

  function currentMovieId() {
    return site ? site.movieKey() : null;
  }

  function setTracks(key, list) {
    tracksByMovie.set(String(key), list);
    refresh();
  }

  function pickTrack(list, lang) {
    const usable = list.filter((t) => !t.forced);
    const exact = usable.filter((t) => t.lang === lang);
    const loose = exact.length
      ? exact
      : usable.filter((t) => t.lang.split('-')[0] === lang.split('-')[0]);
    if (!loose.length) return null;
    let chosen = null;
    try {
      chosen = site && site.chooseTrack ? site.chooseTrack(loose, lang) : null;
    } catch {}
    return chosen || loose.find((t) => t.kind === 'subtitles') || loose[0];
  }

  async function refresh() {
    const movie = currentMovieId();
    const list = (movie && tracksByMovie.get(movie)) || [];

    if (!settings.enabled || !movie || !settings.lang) {
      activeKey = '';
      cues = [];
      setStatus(!settings.lang ? 'Pick a language' : settings.enabled ? '' : 'Off');
      publish(movie, list);
      return;
    }

    const track = pickTrack(list, settings.lang);
    if (!track) {
      activeKey = '';
      cues = [];
      setStatus(site.missingMessage(settings.lang, list.length));
      publish(movie, list);
      return;
    }

    const key = movie + '|' + track.urls[0];
    if (key === activeKey) {
      publish(movie, list);
      return;
    }
    activeKey = key;
    cues = [];
    setStatus(`Loading ${track.label}...`);
    publish(movie, list);
    try {
      const loaded = await loadCues(track);
      if (activeKey !== key) return;
      cues = loaded;
      setStatus(`Showing ${track.label}`);
    } catch (e) {
      if (activeKey !== key) return;
      cueCache.delete(track.urls[0]);
      setStatus(`Could not load ${track.label}: ${e.message}`);
    }
    publish(movie, list);
  }

  async function getText(url) {
    const res = await origFetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return { text: await res.text(), url: res.url || url };
  }

  function loadCues(track) {
    const cacheKey = track.urls[0];
    if (!cueCache.has(cacheKey)) {
      cueCache.set(
        cacheKey,
        (async () => {
          if (track.format === HLS) return loadHls(track.urls[0]);
          let lastErr = new Error('no URL');
          for (const url of track.urls) {
            try {
              const { text } = await getText(url);
              const parsed = track.format.startsWith('webvtt') ? parseVtt(text) : parseTtml(text);
              if (!parsed.length) throw new Error('empty subtitle file');
              return parsed;
            } catch (e) {
              lastErr = e;
            }
          }
          throw lastErr;
        })(),
      );
    }
    return cueCache.get(cacheKey);
  }

  // HLS subtitles come as a playlist of small WebVTT files. Their cue times are
  // taken as they are (true for Disney+, which has no X-TIMESTAMP-MAP).
  async function loadHls(playlistUrl) {
    const pl = await getText(playlistUrl);
    const segments = pl.text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => new URL(l, pl.url).href);
    if (!segments.length) throw new Error('empty playlist');

    let failed = 0;
    const texts = await mapLimit(segments, 6, async (url) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return (await getText(url)).text;
        } catch {}
      }
      failed++;
      return '';
    });
    if (failed === segments.length) throw new Error('no subtitle file could be downloaded');

    // A cue that spans two pieces is repeated in both; keep one.
    const seen = new Set();
    const out = [];
    for (const t of texts) {
      for (const c of parseVtt(t)) {
        const k = c.start + '|' + c.end + '|' + c.text;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(c);
      }
    }
    if (!out.length) throw new Error('empty subtitle files');
    out.sort((x, y) => x.start - y.start);
    out.pieces = segments.length;
    out.failedPieces = failed;
    return out;
  }

  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  // ---------- parsers ----------

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '' };

  function decodeEntities(s) {
    return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      const v = ENTITIES[e.toLowerCase()];
      return v === undefined ? m : v;
    });
  }

  function clockToSeconds(s) {
    return s
      .trim()
      .split(':')
      .reduce((acc, part) => acc * 60 + parseFloat(part), 0);
  }

  function parseVtt(text) {
    const out = [];
    for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
      const lines = block.split('\n');
      const i = lines.findIndex((l) => l.includes('-->'));
      if (i < 0) continue;
      const [a, b] = lines[i].split('-->');
      const start = clockToSeconds(a);
      const end = clockToSeconds(b.trim().split(/\s+/)[0]);
      const body = decodeEntities(
        lines
          .slice(i + 1)
          .join('\n')
          .replace(/<[^>]*>/g, ''),
      ).trim();
      if (Number.isFinite(start) && Number.isFinite(end) && body) out.push({ start, end, text: body });
    }
    return out.sort((x, y) => x.start - y.start);
  }

  function parseTtml(text) {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('bad TTML');
    const root = doc.documentElement;
    const tickRate = Number(root.getAttribute('ttp:tickRate')) || 10000000;
    const frameRate = Number(root.getAttribute('ttp:frameRate')) || 30;

    const toSeconds = (v) => {
      if (!v) return NaN;
      let m;
      if ((m = v.match(/^([\d.]+)(h|m|s|ms|f|t)$/))) {
        const n = parseFloat(m[1]);
        return { h: n * 3600, m: n * 60, s: n, ms: n / 1000, f: n / frameRate, t: n / tickRate }[m[2]];
      }
      if ((m = v.match(/^(\d+):(\d+):(\d+):(\d+)$/))) {
        return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / frameRate;
      }
      return clockToSeconds(v);
    };

    const textOf = (node) => {
      let s = '';
      for (const c of node.childNodes) {
        if (c.nodeType === 3) s += c.nodeValue;
        else if (c.nodeType === 1) s += c.localName === 'br' ? '\n' : textOf(c);
      }
      return s;
    };

    const out = [];
    for (const p of doc.getElementsByTagNameNS('*', 'p')) {
      const start = toSeconds(p.getAttribute('begin'));
      let end = toSeconds(p.getAttribute('end'));
      if (!Number.isFinite(end)) end = start + toSeconds(p.getAttribute('dur'));
      const body = textOf(p)
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .trim();
      if (Number.isFinite(start) && Number.isFinite(end) && body) out.push({ start, end, text: body });
    }
    return out.sort((x, y) => x.start - y.start);
  }

  // ---------- finding the video ----------

  // Some players keep a second <video> and may switch between them (Disney+),
  // or use shadow DOM. Follow the element that last reported playback activity.
  let candidates = [];
  let activeVideo = null;
  let lastVideoSearch = 0;
  const watched = new WeakSet();
  const ACTIVITY = ['playing', 'timeupdate', 'seeking', 'seeked', 'loadeddata'];

  function shadowVideos() {
    const found = [];
    const roots = [document];
    for (let i = 0; i < roots.length; i++) {
      for (const el of roots[i].querySelectorAll('*')) {
        if (el.shadowRoot) roots.push(el.shadowRoot);
        if (i > 0 && el.localName === 'video') found.push(el);
      }
    }
    return found;
  }

  function watch(v) {
    if (watched.has(v)) return;
    watched.add(v);
    const mark = () => (activeVideo = v);
    for (const ev of ACTIVITY) v.addEventListener(ev, mark);
  }

  function findVideo() {
    const now = Date.now();
    if (now - lastVideoSearch >= 1000) {
      lastVideoSearch = now;
      candidates = [...document.querySelectorAll('video')];
      if (site && site.shadowVideos) candidates = candidates.concat(shadowVideos());
      candidates.forEach(watch);
    }
    const live = candidates.filter((v) => v.isConnected);
    const playing = live.find((v) => v.readyState > 0 && !v.paused);
    // A playing video wins over one that was merely active before.
    if (activeVideo && activeVideo.isConnected && (!activeVideo.paused || !playing)) return activeVideo;
    return playing || live.find((v) => v.readyState > 0) || live[0] || null;
  }

  // Subtitle files use the title's own timeline; some players restart the
  // video's clock after a seek and the site file says by how much.
  function filmTime(video) {
    let offset = 0;
    try {
      offset = (site && site.timeOffset && site.timeOffset(video)) || 0;
    } catch {}
    return video.currentTime + offset;
  }

  // ---------- rendering ----------

  const BOX_CSS = 'position:absolute;z-index:2;pointer-events:none;';
  let box = null; // covers the video
  let overlay = null; // the subtitle block inside the box
  let line = null;
  let shownText = null;
  let toast = null;
  let toastTimer = 0;

  function playerView(video) {
    return (site && site.playerView && site.playerView(video)) || null;
  }

  // Size the box to the video. A site's player view already matches it;
  // otherwise measure the video against the box's containing block.
  function placeBox(video, view) {
    if (view) {
      box.style.cssText = BOX_CSS + 'left:0;top:0;width:100%;height:100%;';
      return view.clientHeight;
    }
    const parent = box.offsetParent || box.parentElement;
    const vr = video.getBoundingClientRect();
    const pr = parent.getBoundingClientRect();
    box.style.cssText =
      BOX_CSS +
      `left:${vr.left - pr.left - parent.clientLeft + parent.scrollLeft}px;` +
      `top:${vr.top - pr.top - parent.clientTop + parent.scrollTop}px;` +
      `width:${vr.width}px;height:${vr.height}px;`;
    return vr.height;
  }

  function ensureOverlay(video) {
    const view = playerView(video);
    const host = view || video.parentElement;
    if (!box) {
      box = document.createElement('div');
      box.className = 'netfari-box';
      overlay = document.createElement('div');
      overlay.className = 'netfari-overlay';
      overlay.style.cssText = 'position:absolute;left:5%;right:5%;text-align:center;white-space:pre-line;';
      line = document.createElement('span');
      line.style.cssText =
        'display:inline-block;padding:0.1em 0.4em;border-radius:0.2em;color:#fff;' +
        'background:rgba(0,0,0,0.45);font-family:-apple-system,"Helvetica Neue",sans-serif;' +
        'font-weight:500;text-shadow:0 0 0.15em #000,0 0 0.15em #000;';
      overlay.appendChild(line);
      box.appendChild(overlay);
    }
    if (box.parentElement !== host) host.appendChild(box);
    const h = placeBox(video, view) || 720;
    overlay.style.fontSize = (h * settings.size) / 100 + 'px';
    overlay.style.lineHeight = String(settings.lineHeight);
    // Anchor to the nearer edge so extra lines grow toward the middle.
    if (settings.position <= 50) {
      overlay.style.bottom = '';
      overlay.style.top = settings.position + '%';
    } else {
      overlay.style.top = '';
      overlay.style.bottom = 100 - settings.position + '%';
    }
  }

  // A thrown error must not stop the loop, or the last line stays on screen.
  let lastSelection = '';

  function tick() {
    diag.renders++;
    try {
      if (site && site.selectionKey && diag.renders % 10 === 0) {
        const key = String(site.selectionKey());
        if (key !== lastSelection) {
          lastSelection = key;
          refresh();
        }
      }
      render();
    } catch (e) {
      diag.renderError = String(e && e.stack ? e.stack.split('\n')[0] : e);
    }
  }

  function render() {
    const path = location.pathname;
    if (path !== lastPath) {
      lastPath = path;
      shownText = null;
      refresh();
    }

    const video = findVideo();
    let text = '';
    if (video && settings.enabled && cues.length) {
      const t = filmTime(video);
      text = cues
        .filter((c) => c.start <= t && t < c.end)
        .map((c) => c.text)
        .join('\n');
    }

    if (!video || !text) {
      if (overlay && shownText !== '') {
        overlay.style.display = 'none';
        shownText = '';
      }
      return;
    }

    ensureOverlay(video);
    if (text !== shownText) {
      line.textContent = text;
      overlay.style.display = '';
      shownText = text;
    }
  }

  function showToast(message) {
    const video = findVideo();
    const host = (video && (playerView(video) || video.parentElement)) || document.fullscreenElement || document.body;
    if (!toast) {
      toast = document.createElement('div');
      toast.style.cssText =
        'position:absolute;top:16px;left:50%;transform:translateX(-50%);z-index:3;' +
        'pointer-events:none;padding:6px 14px;border-radius:6px;background:rgba(0,0,0,0.75);' +
        'color:#fff;font:600 15px -apple-system,"Helvetica Neue",sans-serif;';
    }
    if (toast.parentElement !== host) host.appendChild(toast);
    if (host === document.body) toast.style.position = 'fixed';
    toast.textContent = message;
    toast.style.display = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.style.display = 'none'), 1200);
  }

  // ---------- bridge to content.js ----------

  function setStatus(s) {
    status = s;
  }

  function publish(movie, list) {
    const seen = new Map();
    for (const t of list) {
      if (t.forced) continue;
      if (!seen.has(t.lang) || t.kind === 'subtitles') seen.set(t.lang, t.label);
    }
    post({
      type: 'state',
      state: {
        site: site ? site.name : '',
        movie,
        tracks: [...seen].map(([lang, label]) => ({ lang, label })),
        status,
      },
    });
  }

  function post(msg) {
    window.postMessage({ [MSG]: 'toContent', ...msg }, location.origin);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data[MSG] !== 'toPage') return;
    if (e.data.type === 'settings') {
      settings = normalize(e.data.settings);
      if (e.data.version) diag.version = e.data.version;
      writeLocal();
      shownText = null;
      refresh();
    } else if (e.data.type === 'toast') {
      showToast(e.data.text);
    } else if (e.data.type === 'getState') {
      const movie = currentMovieId();
      publish(movie, (movie && tracksByMovie.get(movie)) || []);
    }
  });

  // Paste __netfariCore.debug() in the console when something looks wrong.
  // It reports timings and counts only, no subtitle text.
  function debug() {
    const v = findVideo();
    const t = v ? filmTime(v) : null;
    const movie = currentMovieId();
    const list = (movie && tracksByMovie.get(movie)) || [];
    const base = (settings.lang || '').split('-')[0];
    const options = list.filter((o) => o.lang.split('-')[0] === base);
    const chosen = settings.lang ? pickTrack(list, settings.lang) : null;
    let bigGaps = 0;
    for (let i = 1; i < cues.length; i++) if (cues[i].start - cues[i - 1].end > 60) bigGaps++;
    return origStringify({
      version: diag.version,
      loadedBy,
      site: site && site.name,
      movie: currentMovieId(),
      status,
      lang: settings.lang,
      enabled: settings.enabled,
      tracks: list.length,
      // Every track in the chosen language, and which one is shown.
      options: options.map((o) => ({ label: o.label, kind: o.kind, forced: o.forced, format: o.format, info: o.info })),
      chosen: options.indexOf(chosen),
      extra: list.extra || null,
      cues: cues.length,
      firstCueStart: cues.length ? cues[0].start : null,
      lastCueEnd: cues.length ? cues[cues.length - 1].end : null,
      gapsOver60s: bigGaps,
      pieces: cues.pieces ?? null,
      failedPieces: cues.failedPieces ?? null,
      videos: candidates.length,
      videoIndex: candidates.indexOf(v),
      videoTime: v ? v.currentTime : null,
      filmTime: t,
      videoPaused: v ? v.paused : null,
      cuesNow: t === null ? null : cues.filter((c) => c.start <= t && t < c.end).length,
      nextCueAt: t === null ? null : (cues.find((c) => c.start > t) || {}).start,
      overlayInPage: !!(box && box.isConnected),
      overlayShown: !!(overlay && overlay.style.display !== 'none' && shownText),
      renders: diag.renders,
      renderError: diag.renderError,
    });
  }

  window.__netfariCore = {
    HLS,
    debug,
    register(s) {
      if (site) return;
      site = s;
      site.install({ setTracks, settings: () => settings, origParse, origStringify, origFetch });
      setInterval(tick, 100);
      post({ type: 'ready' });
    },
  };
})();
