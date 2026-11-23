<p align="center"><img src="extension/icons/icon-128.png" width="96" height="96" alt="Netfari icon"></p>

# Netfari

Safari web extension that shows a second subtitle language on Netflix and Disney+, with an on/off switch. No account, no tracking, no servers: it only downloads the subtitle files the site already offers for the title.

## Use

- **Toolbar popup:** on/off switch, language, position (slider from the top to the bottom of the video), size, line spacing.
- **Shortcut:** Option+S on the video page toggles the second subtitle and shows a short "on/off" label.
- **Primary subtitle:** pick it in the site's own menu as usual. Netfari draws the other language at the top of the video by default.

Netflix: if the language you want is not listed for a title, choose it under "Other" and reload the video page. The extension then asks Netflix for that language in the next manifest request. Netflix still only returns languages it has for that title.

Disney+: every subtitle language of the title is listed once the video starts. If the list stays empty, reload the page.

## Requirements

- **macOS:** 12 or later, Apple silicon or Intel.
- **Safari:** 15.4 or later (first version with Manifest V3).

## Install

Netfari is not signed with an Apple developer account, so Safari only loads it with "Allow unsigned extensions" on. Safari turns that setting off each time it quits.

Option 1, the app (stays installed). Download `Netfari.dmg` from [Releases](https://github.com/liu-yu-tung/netfari/releases), or build it yourself with Xcode:

```bash
./scripts/build-dmg.sh
```

This converts `extension/` into an Xcode project under `xcode/`, builds it with ad-hoc signing, and writes `build/Netfari.dmg`. Each build gets its own version (the version in `extension/manifest.json` plus a build counter, such as 0.2.0.4), shown in Safari's extension settings and in the popup, so you can tell which build is loaded.

1. Open `build/Netfari.dmg`, drag Netfari into Applications, then eject the disk.
2. Open Netfari from Applications once. If macOS blocks it, use System Settings > Privacy & Security > Open Anyway.
3. Safari > Settings > Advanced: turn on "Show features for web developers". Then turn on "Allow unsigned extensions" (Develop menu, or Settings > Developer in newer Safari).
4. Safari > Settings > Extensions: enable Netfari and allow it on netflix.com and disneyplus.com.

Keep only one copy of Netfari.app around. Safari lists every copy it finds (for example a still-mounted dmg) as a separate extension.

Option 2, Safari 26 or later (no Xcode):

1. Safari > Settings > Advanced: turn on "Show features for web developers".
2. Safari > Settings > Developer: turn on "Allow unsigned extensions", then click "Add Temporary Extension..." and select the `extension` folder.
3. Safari > Settings > Extensions: enable Netfari and allow it on netflix.com and disneyplus.com.

Safari removes temporary extensions after 24 hours or when it quits, so repeat step 2 after that.

## How it works

- `core.js` and the file for the current site from `sites/` run in the page's own JavaScript world. Safari 18 and later start them from the manifest (`"world": "MAIN"`) before the site's scripts, so the first subtitle list is never missed; on older Safari `content.js` injects them. `content.js` passes settings from `browser.storage.local`.
- `core.js` is shared: it downloads the chosen track, parses WebVTT or TTML, and draws the line that matches `video.currentTime` over the video, so it also shows in fullscreen. A new site is one more file in `sites/` (the interface is described at the top of `core.js`).
- `sites/netflix.js` wraps `JSON.stringify` to add text subtitle formats (`webvtt-lssdh-ios8`, `dfxp-ls-sdh`, `imsc1.1`, `simplesdh`) and the chosen language to Netflix's manifest request, and wraps `JSON.parse` to read the subtitle track list from the response. Image-based subtitle tracks are skipped. When a language has both regular subtitles and a DUBTITLE (written for the dub in that language), Netfari uses the track Netflix itself shows for that language, else the DUBTITLE when the audio is in that language, else the regular one. The hook approach follows Tithen-Firion's MIT-licensed Netflix subtitle downloader userscript.
- `sites/disney.js` watches the player's XHR requests for the HLS master playlist (`.m3u8`) and reads its `#EXT-X-MEDIA:TYPE=SUBTITLES` lines. Each language points to a playlist of small WebVTT files, which `core.js` downloads and joins. Forced tracks are skipped, and plain subtitles are preferred over "[CC]".
- The icons in `extension/icons` are drawn by `tools/make_icons.py` (standard library only). To change them, edit the colors or shapes there and run:

```bash
python3 -I tools/make_icons.py extension/icons
```

## Test

- **`test/harness.html`:** fakes a Netflix watch page (manifest request and response, a VTT and a TTML file, a video element) and runs 28 checks against `core.js` and `sites/netflix.js`, including the regular/DUBTITLE choice.
- **`test/disney.html`:** fakes a Disney+ play page (master playlist by XHR, split WebVTT files, a second video the player switches to, the first one in shadow DOM, a MediaSource with a shifted clock) and runs 24 checks against `core.js` and `sites/disney.js`.

```bash
python3 -I test/serve.py 8765
```

Then open `http://localhost:8765/watch/12345` and `http://localhost:8765/play/abc`. Each page title reads "ALL PASS" when every check passes.

## License

Copyright (C) 2026 liu-yu-tung

GPL-3.0-or-later, see `LICENSE`. You can use, change, and share it; versions you distribute must stay open source under the same license.

Netflix, Disney+ and Safari are trademarks of their owners. This project is not affiliated with or endorsed by Netflix, Disney or Apple.
