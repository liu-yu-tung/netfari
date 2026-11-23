// SPDX-License-Identifier: GPL-3.0-or-later
// Netflix: hooks JSON.stringify so the manifest request asks for text subtitle
// formats and the secondary language, and JSON.parse to read the subtitle
// track list from the manifest response.
(() => {
  const core = window.__netfariCore;
  if (!core) return;

  // Preferred order: WebVTT is the simplest to parse; the rest are TTML.
  const FORMATS = ['webvtt-lssdh-ios8', 'dfxp-ls-sdh', 'imsc1.1', 'simplesdh'];
  const MANIFEST_RE = /manifest|licensedManifest/i;
  const idOverrides = new Map(); // /watch/<id> -> manifest movieId

  core.register({
    name: 'netflix',

    install(api) {
      const { origParse, origStringify } = api;

      JSON.parse = function () {
        const data = origParse.apply(this, arguments);
        try {
          const r = data && data.result;
          if (r && r.movieId && (r.timedtexttracks || r.textTracks)) api.setTracks(r.movieId, readTracks(r));
        } catch (e) {
          console.warn('[Netfari] manifest read failed', e);
        }
        return data;
      };

      JSON.stringify = function (value) {
        try {
          patchRequest(value, api.settings());
        } catch {}
        return origStringify.apply(this, arguments);
      };
    },

    movieKey() {
      const m = location.pathname.match(/\/watch\/(\d+)/);
      if (!m) return null;
      return idOverrides.get(m[1]) || m[1];
    },

    missingMessage(lang, count) {
      return count
        ? `No "${lang}" subtitles here. Reload the video to request it.`
        : 'Waiting for Netflix subtitle list (reload the video if this stays)';
    },

    playerView(video) {
      return video.closest('.watch-video--player-view');
    },
  });

  function patchRequest(data, settings) {
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

  function readTracks(r) {
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
    return list;
  }
})();
