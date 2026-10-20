# SPDX-License-Identifier: GPL-3.0-or-later
"""Local stand-in for Netflix: /watch/<id> serves the harness, /ext/ the extension, /subs/ fixtures."""
import http.server
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EXT = ROOT.parent / "extension"


class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        path = path.split("?", 1)[0]
        if path.startswith("/watch/"):
            return str(ROOT / "harness.html")
        if path.startswith("/ext/"):
            return str(EXT / path[len("/ext/"):])
        if path.startswith("/subs/"):
            return str(ROOT / "fixtures" / path[len("/subs/"):])
        return str(ROOT / path.lstrip("/"))

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
