# Netfari

Safari web extension that shows a second subtitle language on Netflix, with an on/off switch. No account, no tracking, no servers: it only downloads the subtitle files Netflix already offers for the title.

## Use

- **Toolbar popup:** on/off switch, language, position (top or bottom), size.
- **Shortcut:** Option+S on the Netflix page toggles the second subtitle and shows a short "on/off" label.
- **Primary subtitle:** pick it in Netflix's own menu as usual. Netfari draws the other language at the top of the player by default.

If the language you want is not listed for a title, choose it under "Other" and reload the video page. The extension then asks Netflix for that language in the next manifest request. Netflix still only returns languages it has for that title.

## Install

Netfari is not signed with an Apple developer account, so Safari only loads it with "Allow unsigned extensions" on. Safari turns that setting off each time it quits.

Option 1, build the app (stays installed, needs Xcode):

```bash
./scripts/build-dmg.sh
```

This converts `extension/` into an Xcode project under `xcode/`, builds it with ad-hoc signing, and writes `build/Netfari.dmg`.

1. Open `build/Netfari.dmg`, drag Netfari into Applications, then eject the disk.
2. Open Netfari from Applications once. If macOS blocks it, use System Settings > Privacy & Security > Open Anyway.
3. Safari > Settings > Advanced: turn on "Show features for web developers". Then turn on "Allow unsigned extensions" (Develop menu, or Settings > Developer in newer Safari).
4. Safari > Settings > Extensions: enable Netfari and allow it on netflix.com.

Keep only one copy of Netfari.app around. Safari lists every copy it finds (for example a still-mounted dmg) as a separate extension.

Option 2, Safari 26 or later (no Xcode):

1. Safari > Settings > Advanced: turn on "Show features for web developers".
2. Safari > Settings > Developer: turn on "Allow unsigned extensions", then click "Add Temporary Extension..." and select the `extension` folder.
3. Safari > Settings > Extensions: enable Netfari and allow it on netflix.com.

Safari removes temporary extensions after 24 hours or when it quits, so repeat step 2 after that.

## How it works

- `content.js` injects `page.js` into the Netflix page and passes settings from `browser.storage.local`.
- `page.js` wraps `JSON.stringify` to add text subtitle formats (`webvtt-lssdh-ios8`, `dfxp-ls-sdh`, `imsc1.1`, `simplesdh`) and the chosen language to Netflix's manifest request, and wraps `JSON.parse` to read the subtitle track list from the response.
- It downloads the chosen track, parses WebVTT or TTML, and draws the line that matches `video.currentTime` inside the player element, so it also shows in fullscreen.
- Image-based subtitle tracks are skipped.
- The hook approach follows Tithen-Firion's MIT-licensed Netflix subtitle downloader userscript.

## Test

`test/harness.html` fakes a Netflix watch page (manifest request and response, a VTT and a TTML file, a video element) and runs 20 checks against `page.js`.

```bash
python3 -I test/serve.py 8765
```

Then open `http://localhost:8765/watch/12345`. The page title reads "ALL PASS" when every check passes.

## License

Copyright (C) 2026 liu-yu-tung

GPL-3.0-or-later, see `LICENSE`. You can use, change, and share it; versions you distribute must stay open source under the same license.

Netflix and Safari are trademarks of their owners. This project is not affiliated with or endorsed by Netflix or Apple.
