#!/usr/bin/env python3
"""Rebuild HistoricalWow.html by splicing in the latest .jsx / data.js content.

The HTML embeds each source file inside a <script> block. We locate each block
by the unique opening comment (line 2 of every source file) and replace the
body up to the next </script>.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = ROOT / "HistoricalWow.html"

# Each source file's header comment (line 2, after `/* eslint-disable */`)
# is unique enough to anchor the splice.
SOURCES = [
    ("data.js",          "// HistoricalWow data layer."),
    ("helpers.jsx",      "// Shared helpers, icons, lookups, hash router"),
    ("kpalette.jsx",     "// Cmd-K palette + global search"),
    ("lists.jsx",        "// List views — paginated API queries against /api/<table>."),
    ("record.jsx",       "// Record detail page — works for any task table (incident, change_request,"),
    ("refs.jsx",         "// Reference pages: user, group, ci, home dashboard"),
    ("tweaks-panel.jsx", "// tweaks-panel.jsx"),
    ("app.jsx",          "// Main app shell, sidebar, topbar, audit log overlay, router"),
]


def splice(html: str, anchor: str, body: str) -> str:
    """Replace the script block whose body starts with `anchor` (after the
    eslint-disable line) with `body`. Body must NOT include the surrounding
    <script>...</script> tags.
    """
    idx = html.find(anchor)
    if idx == -1:
        raise SystemExit(f"anchor not found: {anchor!r}")
    # Walk back to the opening <script…> line and forward to </script>.
    open_tag_start = html.rfind("<script", 0, idx)
    open_tag_end = html.find(">", open_tag_start) + 1
    close_tag = html.find("</script>", idx)
    if open_tag_start == -1 or close_tag == -1:
        raise SystemExit(f"script boundaries not found around {anchor!r}")
    # Preserve the existing indentation prefix on the </script> line.
    line_start = html.rfind("\n", 0, close_tag) + 1
    indent = html[line_start:close_tag]
    return (
        html[:open_tag_end]
        + "\n" + body.rstrip() + "\n"
        + indent
        + html[close_tag:]
    )


def main() -> None:
    html = HTML.read_text()
    for name, anchor in SOURCES:
        src = (ROOT / name).read_text()
        html = splice(html, anchor, src)
    HTML.write_text(html)
    print(f"rebuilt {HTML} ({len(html):,} bytes)")


if __name__ == "__main__":
    main()
