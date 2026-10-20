// SPDX-License-Identifier: GPL-3.0-or-later
// Runs in the page's own JS world (injected by content.js).
// 1. Hooks JSON.stringify so Netflix's manifest request asks for text subtitle
//    formats and the secondary language.
// 2. Hooks JSON.parse to capture the subtitle track list from the manifest.
// 3. Downloads the chosen track and draws it over the video.
(() => {
  if (window.__netfariLoaded) return;
  window.__netfariLoaded = true;

  const MSG = '__netfari';
  const LS_KEY = 'netfari.settings';
  // Preferred order: WebVTT is the simplest to parse; the rest are TTML.
  const FORMATS = ['webvtt-lssdh-ios8', 'dfxp-ls-sdh', 'imsc1.1', 'simplesdh'];
  const MANIFEST_RE = /manifest|licensedManifest/i;
  const DEFAULTS = { enabled: true, lang: '', position: 'top', size: 4.5 };

  const origParse = JSON.parse;
  const origStringify = JSON.stringify;

  let settings = { ...DEFAULTS, ...readLocal() };
  const tracksByMovie = new Map(); // manifest movieId -> track list
  const idOverrides = new Map(); // /watch/<id> -> manifest movieId
  const cueCache = new Map(); // url -> Promise<cues>
  let cues = [];
  let activeKey = '';
  let status = '';
  let lastPath = '';

  function readLocal() {
    try {
      return origParse(localStorage.getItem(LS_KEY) || '{}');
    } catch {
      return {};
    }
  }

  function writeLocal() {
    try {
      localStorage.setItem(LS_KEY, origStringify(settings));
    } catch {}
  }

  // ---------- hooks ----------

  JSON.parse = function () {
    const data = origParse.apply(this, arguments);
    try {
      const r = data && data.result;
      if (r && r.movieId && (r.timedtexttracks || r.textTracks)) onManifest(r);
    } catch (e) {
      console.warn('[Netfari] manifest read failed', e);
    }
    return data;
  };

  JSON.stringify = function (value) {
    try {
      patchRequest(value);
    } catch {}
    return origStringify.apply(this, arguments);
  };

  function patchRequest(data) {
    if (!data || typeof data !== 'object') return;

    if (typeof data.url === 'string' && MANIFEST_RE.test(data.url)) {
      for (const v of Object.values(data)) {
        if (!v || typeof v !== 'object' || !Array.isArray(v.profiles)) continue;
        for (const p of FORMATS) if (!v.profiles.includes(p)) v.profiles.push(p);
        if ('showAllSubDubTracks' in v) v.showAllSubDubTracks = true;
        // Without this Netflix often leaves the secondary language out of the list.
        if (settings.lang) v.preferredTextLocale = settings.lang;
      }
    }

    // Episode URLs can differ from the manifest movieId; remember the mapping.
    if (typeof data.movieId === 'number') {
      const videoId = data.params?.sessionParams?.uiplaycontext?.video_id;
      if (typeof videoId === 'number' && videoId !== data.movieId) {
        idOverrides.set(String(videoId), String(data.movieId));
      }
    }
  }

  function onManifest(r) {
    const list = [];
    for (const t of r.timedtexttracks || r.textTracks || []) {
      if (!t || t.isNoneTrack) continue;
      const dl = t.ttDownloadables || t.downloadables || {};
      for (const format of FORMATS) {
        const d = dl[format];
        if (!d) continue;
        const urls = d.downloadUrls
          ? Object.values(d.downloadUrls)
          : Array.isArray(d.urls)
            ? d.urls.map((u) => u && u.url).filter(Boolean)
            : [];
        if (!urls.length) continue;
        list.push({
          lang: t.language,
          label: t.languageDescription || t.language,
          kind: t.rawTrackType || '',
          forced: !!t.isForcedNarrative,
          format,
          urls,
        });
        break;
      }
    }
    tracksByMovie.set(String(r.movieId), list);
    refresh();
  }

  // ---------- track choice and loading ----------

  function currentMovieId() {
    const m = location.pathname.match(/\/watch\/(\d+)/);
    if (!m) return null;
    return idOverrides.get(m[1]) || m[1];
  }

  function pickTrack(list, lang) {
    const usable = list.filter((t) => !t.forced);
    const exact = usable.filter((t) => t.lang === lang);
    const loose = exact.length
      ? exact
      : usable.filter((t) => t.lang.split('-')[0] === lang.split('-')[0]);
    return loose.find((t) => t.kind === 'subtitles') || loose[0] || null;
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
      setStatus(
        list.length
          ? `No "${settings.lang}" subtitles here. Reload the video to request it.`
          : 'Waiting for Netflix subtitle list (reload the video if this stays)',
      );
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

  function loadCues(track) {
    const cacheKey = track.urls[0];
    if (!cueCache.has(cacheKey)) {
      cueCache.set(
        cacheKey,
        (async () => {
          let lastErr = new Error('no URL');
          for (const url of track.urls) {
            try {
              const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
              if (!res.ok) throw new Error('HTTP ' + res.status);
              const text = await res.text();
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

  // ---------- rendering ----------

  let overlay = null;
  let line = null;
  let shownText = null;
  let toast = null;
  let toastTimer = 0;

  function playerHost(video) {
    return video.closest('.watch-video--player-view') || video.parentElement;
  }

  function ensureOverlay(host) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'netfari-overlay';
      overlay.style.cssText =
        'position:absolute;left:5%;right:5%;z-index:2;pointer-events:none;' +
        'text-align:center;line-height:1.25;white-space:pre-line;';
      line = document.createElement('span');
      line.style.cssText =
        'display:inline-block;padding:0.1em 0.4em;border-radius:0.2em;color:#fff;' +
        'background:rgba(0,0,0,0.45);font-family:-apple-system,"Helvetica Neue",sans-serif;' +
        'font-weight:500;text-shadow:0 0 0.15em #000,0 0 0.15em #000;';
      overlay.appendChild(line);
    }
    if (overlay.parentElement !== host) host.appendChild(overlay);
    const h = host.clientHeight || 720;
    overlay.style.fontSize = (h * settings.size) / 100 + 'px';
    if (settings.position === 'bottom') {
      overlay.style.top = '';
      overlay.style.bottom = '20%';
    } else {
      overlay.style.bottom = '';
      overlay.style.top = '7%';
    }
  }

  function render() {
    const path = location.pathname;
    if (path !== lastPath) {
      lastPath = path;
      shownText = null;
      refresh();
    }

    const video = document.querySelector('video');
    let text = '';
    if (video && settings.enabled && cues.length) {
      const t = video.currentTime;
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

    ensureOverlay(playerHost(video));
    if (text !== shownText) {
      line.textContent = text;
      overlay.style.display = '';
      shownText = text;
    }
  }

  function showToast(message) {
    const video = document.querySelector('video');
    const host = (video && playerHost(video)) || document.fullscreenElement || document.body;
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

  setInterval(render, 100);

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
      settings = { ...DEFAULTS, ...e.data.settings };
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

  post({ type: 'ready' });
})();
