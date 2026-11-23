// SPDX-License-Identifier: GPL-3.0-or-later
// Disney+: the player downloads an HLS master playlist (.m3u8) with XHR. Its
// #EXT-X-MEDIA:TYPE=SUBTITLES lines list every subtitle language; each points
// to a playlist of small WebVTT files, which core.js downloads and joins.
(() => {
  const core = window.__netfariCore;
  if (!core) return;

  const M3U8_RE = /\.m3u8(\?|#|$)/i;
  let pathWithTracks = '';
  // blob: URL -> MediaSource, to read the time shift of the stream behind a <video>.
  const sources = new Map();

  core.register({
    name: 'disney',
    shadowVideos: true,

    install(api) {
      // After a seek the player builds a new MediaSource and sets
      // SourceBuffer.timestampOffset to minus the seek point, so the video's
      // clock restarts near 0. Remember which blob URL belongs to which source.
      const origCreate = URL.createObjectURL;
      URL.createObjectURL = function (obj) {
        const url = origCreate.apply(this, arguments);
        try {
          if (isMediaSource(obj)) {
            sources.set(url, obj);
            if (sources.size > 20) sources.delete(sources.keys().next().value);
          }
        } catch {}
        return url;
      };

      const origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url) {
        try {
          if (M3U8_RE.test(String(url))) {
            this.addEventListener('load', () => {
              readXhrText(this).then((text) => checkMaster(api, text, this.responseURL || String(url)));
            });
          }
        } catch {}
        return origOpen.apply(this, arguments);
      };

      // Not used by Disney+ today; here in case the player moves to fetch.
      const origFetch = api.origFetch;
      window.fetch = function (input) {
        const p = origFetch.apply(this, arguments);
        try {
          const url = typeof input === 'string' ? input : input && input.url;
          if (url && M3U8_RE.test(url)) {
            p.then((res) => res.clone().text().then((text) => checkMaster(api, text, res.url || url))).catch(() => {});
          }
        } catch {}
        return p;
      };
    },

    // The master playlist carries no title id, so tracks are keyed by the page path.
    movieKey() {
      const p = location.pathname;
      return /\/(play|video)\//.test(p) || p === pathWithTracks ? p : null;
    },

    // Title time = video time - timestampOffset (the offset is negative after a seek).
    timeOffset(video) {
      const ms = video.srcObject || sources.get(video.currentSrc || video.src);
      if (!ms || !isMediaSource(ms) || !ms.sourceBuffers.length) return 0;
      const o = ms.sourceBuffers[0].timestampOffset;
      return Number.isFinite(o) ? -o : 0;
    },

    missingMessage(lang, count) {
      return count
        ? `No "${lang}" subtitles on this title.`
        : 'Waiting for the Disney+ subtitle list (reload the page if this stays)';
    },
  });

  function isMediaSource(obj) {
    return (
      (window.MediaSource && obj instanceof MediaSource) ||
      (window.ManagedMediaSource && obj instanceof window.ManagedMediaSource)
    );
  }

  async function readXhrText(xhr) {
    try {
      const t = xhr.responseType;
      if (t === '' || t === 'text') return xhr.responseText;
      if (t === 'arraybuffer') return new TextDecoder().decode(xhr.response);
      if (t === 'blob') return await xhr.response.text();
    } catch {}
    return '';
  }

  function parseAttrs(s) {
    const out = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, '');
    return out;
  }

  // Only the master playlist lists subtitle renditions; media playlists are ignored.
  function checkMaster(api, text, baseUrl) {
    if (!text || !text.includes('TYPE=SUBTITLES')) return;
    const list = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('#EXT-X-MEDIA:') || !line.includes('TYPE=SUBTITLES')) continue;
      const a = parseAttrs(line.slice('#EXT-X-MEDIA:'.length));
      if (!a.URI || !a.LANGUAGE) continue;
      list.push({
        lang: a.LANGUAGE,
        label: a.NAME || a.LANGUAGE,
        // "English [CC]" also describes sounds; plain subtitles are preferred.
        kind: /\[CC\]/i.test(a.NAME || '') ? 'closedcaptions' : 'subtitles',
        forced: a.FORCED === 'YES',
        format: core.HLS,
        urls: [new URL(a.URI, baseUrl).href],
      });
    }
    if (!list.length) return;
    pathWithTracks = location.pathname;
    api.setTracks(pathWithTracks, list);
  }
})();
