#!/usr/bin/env python3
"""
Verify the SQLite DB is consistent with the NDJSON archive on disk.

Counterpart to ../export/verify_export.py (which checks the NDJSON archive
against the original probe). This one checks that build_sqlite.py produced
a DB that matches the NDJSON it was built from.

Run after a build_sqlite.py invocation, or whenever the API server is
returning suspicious row counts.

Usage:
  cd project
  python3 bin/verify_sqlite.py

Reports:
  - Per-table row counts: NDJSON vs DB, with deltas
  - Tables present in NDJSON but missing from the DB (needs build_sqlite.py)
  - _build_state contents (per-table cursors, last build time)
  - Index count per table
  - SQLite PRAGMA integrity_check

Exits non-zero if any table's DB row count is below its NDJSON row count
(the "DB lags NDJSON" condition that means a fresh build is overdue).
"""
import json
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / 'data'
DB_PATH = DATA / 'historicalwow.db'


def count_lines(p):
    """Streaming line count. For sys_audit.ndjson at 13 GB this takes
    1-2 min; everything else is sub-second."""
    if not p.exists():
        return 0
    n = 0
    with p.open('rb') as f:
        for _ in f:
            n += 1
    return n


def main():
    if not DB_PATH.is_file():
        print(f'DB not found at {DB_PATH}')
        print('Run: python3 bin/build_sqlite.py')
        sys.exit(2)

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    # --- 1. Discover tables in both worlds -------------------------------

    db_tables = sorted([
        r['name'] for r in conn.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type='table' AND name NOT LIKE '_%' "
            "AND name NOT LIKE 'sqlite_%'"
        )
    ])
    ndjson_tables = sorted([p.stem for p in DATA.glob('*.ndjson')])
    all_tables = sorted(set(db_tables) | set(ndjson_tables))

    # --- 2. Per-table row count comparison -------------------------------

    print('Row counts (NDJSON file vs SQLite table):')
    print(f'  {"Table":<32} {"NDJSON":>14} {"DB":>14} {"Δ":>11}  Status')
    print('  ' + '-' * 88)

    issues_lag = []      # DB has fewer rows than NDJSON
    issues_missing = []  # NDJSON has data but no DB table

    for t in all_tables:
        ndjson_path = DATA / f'{t}.ndjson'
        ndjson_count = count_lines(ndjson_path) if ndjson_path.exists() else 0

        db_count = None
        if t in db_tables:
            try:
                db_count = conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
            except sqlite3.Error:
                db_count = None

        statuses = []

        if ndjson_count > 0 and db_count is None:
            statuses.append('DB MISSING')
            issues_missing.append(t)
        elif ndjson_count == 0 and (db_count or 0) > 0:
            statuses.append('DB ahead of NDJSON (strange)')
        elif (db_count or 0) < ndjson_count and ndjson_count > 0:
            # Some defensive tolerance: NDJSON merge can introduce empty
            # trailing lines on rare edge cases; allow a 0.01% drift before
            # flagging.
            tolerance = max(2, int(ndjson_count * 0.0001))
            if ndjson_count - (db_count or 0) > tolerance:
                statuses.append('DB LAGS NDJSON — rebuild needed')
                issues_lag.append((t, ndjson_count, db_count or 0))
            else:
                statuses.append('within tolerance')
        else:
            statuses.append('✓')

        delta = (db_count or 0) - ndjson_count
        delta_str = f'{delta:+,}' if delta != 0 else '0'
        ndjson_str = f'{ndjson_count:,}' if ndjson_count > 0 else '—'
        db_str = f'{(db_count or 0):,}' if db_count is not None else '—'
        print(f'  {t:<32} {ndjson_str:>14} {db_str:>14} {delta_str:>11}  {", ".join(statuses)}')

    # --- 3. _build_state ---------------------------------------------------

    print()
    try:
        state = list(conn.execute(
            'SELECT * FROM _build_state ORDER BY table_name'
        ))
    except sqlite3.OperationalError:
        state = []
        print('  ⚠  _build_state table missing — next run will recover '
              'cursors from MAX(delta_field) of existing rows')

    if state:
        print(f'_build_state ({len(state)} tables tracked):')
        for r in state:
            cursor = r['last_cursor'] or '-'
            print(f'  {r["table_name"]:<32} cursor={cursor:<22} '
                  f'rows={r["rows_total"]:>10,}  built={r["last_built_at"]}')

    # --- 4. Indexes --------------------------------------------------------

    print()
    print('Indexes per table:')
    for t in db_tables:
        n = conn.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND tbl_name = ?",
            (t,)
        ).fetchone()[0]
        print(f'  {t:<32} {n} indexes')

    # --- 5. SQLite integrity ----------------------------------------------

    print()
    print('PRAGMA integrity_check (this scans the whole DB — can take a few min)…')
    res = conn.execute('PRAGMA integrity_check').fetchone()
    integ = res[0] if res else 'unknown'
    print(f'  result: {integ}')

    # --- 6. Summary --------------------------------------------------------

    print()
    print('=' * 70)
    if issues_missing:
        print(f'  ✗ {len(issues_missing)} table(s) present in NDJSON but missing from DB:')
        for t in issues_missing:
            print(f'      - {t}')
    if issues_lag:
        print(f'  ⚠  {len(issues_lag)} table(s) have fewer rows in DB than NDJSON:')
        for t, n_count, d_count in issues_lag:
            print(f'      - {t}: NDJSON={n_count:,}  DB={d_count:,}  '
                  f'(missing {n_count - d_count:,})')
    integ_ok = (integ or '').strip() == 'ok'
    if not integ_ok:
        print(f'  ✗ SQLite integrity check failed: {integ}')

    if not (issues_missing or issues_lag) and integ_ok:
        size_mb = DB_PATH.stat().st_size / 1024 / 1024
        total = sum((r['rows_total'] or 0) for r in state) if state else \
                sum(conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
                    for t in db_tables)
        print(f'  ✓ DB consistent with NDJSON. {len(db_tables)} tables, '
              f'{total:,} rows, {size_mb:.0f} MB.')
        sys.exit(0)
    else:
        print()
        print('  Recommended: python3 bin/build_sqlite.py    '
              '(incremental — should be fast)')
        sys.exit(1)


if __name__ == '__main__':
    main()
