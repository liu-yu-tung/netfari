// SPDX-License-Identifier: GPL-3.0-or-later
// Isolated content script: injects page.js, passes settings in, answers the popup,
// and handles the on/off keyboard shortcut (Option+S).
(() => {
  const api = globalThis.browser || globalThis.chrome;
  const MSG = '__netfari';
  const DEFAULTS = { enabled: true, lang: '', position: 'top', size: 4.5 };

  let settings = { ...DEFAULTS };
  let state = { movie: null, tracks: [], status: '' };

  const script = document.createElement('script');
  script.src = api.runtime.getURL('page.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);

  function toPage(msg) {
    window.postMessage({ [MSG]: 'toPage', ...msg }, location.origin);
  }

  function sendSettings() {
    toPage({ type: 'settings', settings });
  }

  api.storage.local.get(DEFAULTS).then((s) => {
    settings = { ...DEFAULTS, ...s };
    sendSettings();
  });

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;
    sendSettings();
  });

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data[MSG] !== 'toContent') return;
    if (e.data.type === 'ready') sendSettings();
    else if (e.data.type === 'state') state = e.data.state;
  });

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'getState') {
      toPage({ type: 'getState' });
      sendResponse(state);
    }
  });

  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.code !== 'KeyS') return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      e.stopPropagation();
      const enabled = !settings.enabled;
      api.storage.local.set({ enabled });
      toPage({ type: 'toast', text: `Second subtitle: ${enabled ? 'on' : 'off'}` });
    },
    true,
  );
})();
