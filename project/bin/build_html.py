#!/usr/bin/env python3
"""Rebuild HistoricalWow.html by splicing in the latest .jsx / data.js / .css content.

The HTML embeds each source file inside a <script> or <style> block. We
locate each block by the unique opening comment (line 2 of every source
file, or line 1 for CSS) and replace the body up to the closing tag.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = ROOT / "HistoricalWow.html"

# Each source file's header comment is unique enough to anchor the splice.
JS_SOURCES = [
    ("data.js",          "// HistoricalWow data layer."),
    ("helpers.jsx",      "// Shared helpers, icons, lookups, hash router"),
    ("kpalette.jsx",     "// Cmd-K palette + global search"),
    ("lists.jsx",        "// List views — paginated API queries against /api/<table>."),
    ("record.jsx",       "// Record detail page — works for any task table (incident, change_request,"),
    ("refs.jsx",         "// Reference pages: user, group, ci, home dashboard"),
    ("tweaks-panel.jsx", "// tweaks-panel.jsx"),
    ("app.jsx",          "// Main app shell, sidebar, topbar, audit log overlay, router"),
]
CSS_SOURCES = [
    ("styles.css",       "/* HistoricalWow — ServiceNow Historical Archive Viewer */"),
]


def splice(html: str, anchor: str, body: str, close_tag: str) -> str:
    """Replace the block whose body starts with `anchor` with `body`.
    `close_tag` is '</script>' or '</style>'. Body must NOT include the
    surrounding tags."""
    idx = html.find(anchor)
    if idx == -1:
        raise SystemExit(f"anchor not found: {anchor!r}")
    open_tag_str = '<script' if close_tag == '</script>' else '<style'
    open_tag_start = html.rfind(open_tag_str, 0, idx)
    open_tag_end = html.find(">", open_tag_start) + 1
    close_idx = html.find(close_tag, idx)
    if open_tag_start == -1 or close_idx == -1:
        raise SystemExit(f"block boundaries not found around {anchor!r}")
    line_start = html.rfind("\n", 0, close_idx) + 1
    indent = html[line_start:close_idx]
    return (
        html[:open_tag_end]
        + "\n" + body.rstrip() + "\n"
        + indent
        + html[close_idx:]
    )


def main() -> None:
    html = HTML.read_text()
    for name, anchor in CSS_SOURCES:
        src = (ROOT / name).read_text()
        html = splice(html, anchor, src, "</style>")
    for name, anchor in JS_SOURCES:
        src = (ROOT / name).read_text()
        html = splice(html, anchor, src, "</script>")
    HTML.write_text(html)
    print(f"rebuilt {HTML} ({len(html):,} bytes)")


if __name__ == "__main__":
    main()
