// SPDX-License-Identifier: GPL-3.0-or-later
const api = globalThis.browser || globalThis.chrome;
const DEFAULTS = { enabled: true, lang: '', position: 7, size: 4.5, lineHeight: 1.25 };
const LEGACY_POSITION = { top: 7, bottom: 80 };

// Fallback list when the current tab has no track list yet.
const COMMON_LANGS = [
  'ar', 'cs', 'da', 'de', 'el', 'en', 'es', 'es-ES', 'fi', 'fr', 'he', 'hi', 'hr', 'hu',
  'id', 'it', 'ja', 'ko', 'ms', 'nb', 'nl', 'pl', 'pt', 'pt-BR', 'ro', 'ru', 'sv', 'th',
  'tr', 'uk', 'vi', 'zh-Hans', 'zh-Hant',
];

const $ = (id) => document.getElementById(id);
const names = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' });
  } catch {
    return null;
  }
})();
const nameOf = (code) => {
  try {
    return (names && names.of(code)) || code;
  } catch {
    return code;
  }
};

async function pageState() {
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https?:\/\/([^/]*\.)?(netflix|disneyplus)\.com\//.test(tab.url || '')) return null;
    return await api.tabs.sendMessage(tab.id, { type: 'getState' });
  } catch {
    return null;
  }
}

function fillLanguages(select, current, tracks, site) {
  select.textContent = '';
  const none = new Option('Choose...', '');
  select.add(none);

  const available = new Set(tracks.map((t) => t.lang));
  if (tracks.length) {
    const group = document.createElement('optgroup');
    group.label = 'On this title';
    for (const t of tracks) group.appendChild(new Option(`${t.label} (${t.lang})`, t.lang));
    select.appendChild(group);
  }

  const rest = COMMON_LANGS.filter((c) => !available.has(c));
  if (current && !available.has(current) && !rest.includes(current)) rest.unshift(current);
  const group = document.createElement('optgroup');
  // Netflix can add a language on the next load; Disney+ always lists all of them.
  group.label = !tracks.length ? 'Languages' : site === 'disney' ? 'Other (not on this title)' : 'Other (reload the video after choosing)';
  for (const c of rest) group.appendChild(new Option(`${nameOf(c)} (${c})`, c));
  select.appendChild(group);

  select.value = current || '';
}

async function main() {
  $('version').textContent = api.runtime.getManifest().version;
  const settings = { ...DEFAULTS, ...(await api.storage.local.get(DEFAULTS)) };
  const state = await pageState();

  $('enabled').checked = settings.enabled;
  $('position').value = LEGACY_POSITION[settings.position] ?? settings.position;
  $('size').value = settings.size;
  $('lineHeight').value = settings.lineHeight;
  fillLanguages($('lang'), settings.lang, (state && state.tracks) || [], state && state.site);

  if (!state) $('status').textContent = 'Open a Netflix or Disney+ video to see its languages.';
  else if (!state.movie) $('status').textContent = 'Start playing a video.';
  else $('status').textContent = state.status || '';

  $('enabled').addEventListener('change', (e) => api.storage.local.set({ enabled: e.target.checked }));
  $('lang').addEventListener('change', (e) => {
    api.storage.local.set({ lang: e.target.value });
    const onTitle = state && state.tracks.some((t) => t.lang === e.target.value);
    if (state && state.movie && e.target.value && !onTitle) {
      $('status').textContent =
        state.site === 'disney' ? 'Not on this title.' : 'Not on this title yet. Reload the video page to request it.';
    }
  });
  for (const id of ['position', 'size', 'lineHeight']) {
    $(id).addEventListener('input', (e) => api.storage.local.set({ [id]: Number(e.target.value) }));
  }

  if (state) {
    setInterval(async () => {
      const s = await pageState();
      if (s && s.movie && s.status) $('status').textContent = s.status;
    }, 1000);
  }
}

main();
