// SPDX-License-Identifier: GPL-3.0-or-later
const api = globalThis.browser || globalThis.chrome;
const DEFAULTS = { enabled: true, lang: '', position: 'top', size: 4.5 };

// Fallback list when the current tab has no Netflix track list yet.
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
    if (!tab || !/netflix\.com/.test(tab.url || '')) return null;
    return await api.tabs.sendMessage(tab.id, { type: 'getState' });
  } catch {
    return null;
  }
}

function fillLanguages(select, current, tracks) {
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
  group.label = tracks.length ? 'Other (reload the video after choosing)' : 'Languages';
  for (const c of rest) group.appendChild(new Option(`${nameOf(c)} (${c})`, c));
  select.appendChild(group);

  select.value = current || '';
}

async function main() {
  const settings = { ...DEFAULTS, ...(await api.storage.local.get(DEFAULTS)) };
  const state = await pageState();

  $('enabled').checked = settings.enabled;
  $('position').value = settings.position;
  $('size').value = settings.size;
  fillLanguages($('lang'), settings.lang, (state && state.tracks) || []);

  if (!state) $('status').textContent = 'Open a Netflix video to see its languages.';
  else if (!state.movie) $('status').textContent = 'Start playing a video.';
  else $('status').textContent = state.status || '';

  $('enabled').addEventListener('change', (e) => api.storage.local.set({ enabled: e.target.checked }));
  $('lang').addEventListener('change', (e) => {
    api.storage.local.set({ lang: e.target.value });
    const onTitle = state && state.tracks.some((t) => t.lang === e.target.value);
    if (state && state.movie && e.target.value && !onTitle) {
      $('status').textContent = 'Not on this title yet. Reload the video page to request it.';
    }
  });
  $('position').addEventListener('change', (e) => api.storage.local.set({ position: e.target.value }));
  $('size').addEventListener('input', (e) => api.storage.local.set({ size: Number(e.target.value) }));

  if (state) {
    setInterval(async () => {
      const s = await pageState();
      if (s && s.movie && s.status) $('status').textContent = s.status;
    }, 1000);
  }
}

main();
