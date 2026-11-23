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

    // A language can have two tracks: regular subtitles (translated from the
    // original audio) and a DUBTITLE (follows the dub in that language).
    chooseTrack(tracks, lang) {
      const p = player();
      const shown = p && p.getTextTrack && p.getTextTrack();
      // Same language as Netflix's own subtitle: use exactly that track.
      const same = shown && tracks.find((t) => t.id && t.id === shown.trackId);
      if (same) return same;
      const audio = (p && p.getAudioTrack && p.getAudioTrack()) || {};
      const wantDub = !!audio.bcp47 && audio.bcp47.split('-')[0] === lang.split('-')[0];
      const score = (t) => (t.variant === 'DUBTITLE') === wantDub;
      return (
        tracks.find((t) => score(t) && t.kind === 'subtitles') ||
        tracks.find(score) ||
        null
      );
    },

    selectionKey() {
      const p = player();
      if (!p) return '';
      const a = p.getAudioTrack && p.getAudioTrack();
      const t = p.getTextTrack && p.getTextTrack();
      return (a && a.trackId) + '|' + (t && t.trackId);
    },
  });

  // Netflix's own player object, or null. Used only to read which audio and
  // subtitle tracks are selected.
  function player() {
    try {
      const vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const ids = vp.getAllPlayerSessionIds();
      return vp.getVideoPlayerBySessionId(ids.find((id) => id.startsWith('watch')) || ids[0]) || null;
    } catch {
      return null;
    }
  }

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

  // Netflix's own description of a track (ids, type, flags, and short id lists
  // such as which subtitle tracks go with an audio track), for debug().
  function shortFields(t) {
    const out = {};
    const small = (v) => typeof v === 'boolean' || typeof v === 'number' || (typeof v === 'string' && v.length <= 120);
    for (const [k, v] of Object.entries(t)) {
      if (small(v)) out[k] = v;
      else if (Array.isArray(v) && v.length <= 80 && v.every(small)) out[k] = v;
    }
    return out;
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
          id: t.id || t.new_track_id || '',
          variant: t.trackVariant || '',
          format,
          urls,
          info: shortFields(t),
        });
        break;
      }
    }
    list.extra = { audio: (r.audio_tracks || r.audioTracks || []).map(shortFields) };
    return list;
  }
})();
