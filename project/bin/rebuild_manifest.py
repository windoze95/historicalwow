#!/usr/bin/env python3
"""Reconstruct manifest.json from the SQLite row counts and the exporter's
_state.json watermarks.

Useful when a selective export run (SN_TABLES=…) overwrote manifest.json
with only the partial set of tables. The viewer's home-page tiles,
sidebar counts, and snapshot integrity panel all read from manifest.json,
so a partial manifest produces visible weirdness even though the DB has
the full data.
"""
import json
import os
import sqlite3
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / 'data'
DB_PATH = DATA / 'historicalwow.db'
STATE_PATH = DATA / '_state.json'
MANIFEST_PATH = DATA / 'manifest.json'

INSTANCE = os.environ.get('SN_INSTANCE') or os.environ.get('HISTORICALWOW_INSTANCE') or ''


def main():
    state = {}
    try:
        state = json.loads(STATE_PATH.read_text(encoding='utf-8'))
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    watermarks = state.get('watermarks', {}) if isinstance(state, dict) else {}

    prev = {}
    try:
        prev = json.loads(MANIFEST_PATH.read_text(encoding='utf-8'))
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    conn = sqlite3.connect(f'file:{DB_PATH}?mode=ro', uri=True)
    rows_in_table = {
        r[0]: conn.execute(f'SELECT count(*) FROM "{r[0]}"').fetchone()[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\'"
        )
    }
    conn.close()

    tables = []
    for t, n in sorted(rows_in_table.items()):
        tables.append({
            'table': t,
            'rows': n,
            'source_rows': n,
            'watermark': watermarks.get(t, ''),
        })

    manifest = {
        'label': prev.get('label') or os.environ.get('SN_MANIFEST_LABEL', 'export'),
        'snapshot_date': time.strftime('%Y-%m-%d'),
        'instance': prev.get('instance') or INSTANCE,
        'captured_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'tables': tables,
        'integrity': prev.get('integrity') or {
            'sha256_manifest': '',
            'acl_skips': 0,
            'missing_attachments': 0,
        },
    }

    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    total = sum(t['rows'] for t in tables)
    print(f'Wrote {MANIFEST_PATH} — {len(tables)} tables, {total:,} rows total')


if __name__ == '__main__':
    main()
