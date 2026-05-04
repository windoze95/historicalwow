#!/usr/bin/env python3
"""
Convert the NDJSON archive in ../data/ into a single indexed SQLite database
at ../data/historicalwow.db. Run this once after each export run; the API
server then queries the resulting DB instead of streaming NDJSON files into
the browser (which OOMs for 16M+ rows).

Usage:
  cd project
  python3 bin/build_sqlite.py
  # or: python3 bin/build_sqlite.py --rebuild     (drop and recreate)

Stdlib only (sqlite3 + json + pathlib). No pip dependencies.

Schema:
  Each ServiceNow table becomes a SQLite table with the same name, with:
    - sys_id    TEXT PRIMARY KEY  (extracted from the row's sys_id field)
    - <key indexed columns>     extracted from the row for indexing/filtering
    - raw       TEXT             the full {value, display_value} envelope JSON

  Indexed columns are picked per-table to match the lookups the viewer makes.
  Anything else stays inside `raw` and is dug out at SELECT time.
"""
import argparse
import json
import sqlite3
import sys
import time
from pathlib import Path


HERE = Path(__file__).resolve().parent
DATA = HERE.parent / 'data'
DB_PATH = DATA / 'historicalwow.db'


# --- field extraction (handles {value, display_value} envelope) -------------

def _v(field):
    """Pull `value` from {value, display_value} envelope, else return raw."""
    if isinstance(field, dict):
        return field.get('value')
    return field


def _dv(field):
    """Pull `display_value` (with fallback to value)."""
    if isinstance(field, dict):
        return field.get('display_value') or field.get('value')
    return field


# --- per-table schema definitions ------------------------------------------
# Each entry: (table_name, [ (col, extractor_lambda) ])
# 'sys_id' is added automatically. 'raw' is the full row JSON.

TASK_INDEXED_COLS = [
    ('number',           lambda r: _v(r.get('number'))),
    ('short_description',lambda r: _v(r.get('short_description'))),
    ('state',            lambda r: _v(r.get('state'))),
    ('priority',         lambda r: _v(r.get('priority'))),
    ('assigned_to',      lambda r: _v(r.get('assigned_to'))),
    ('assignment_group', lambda r: _v(r.get('assignment_group'))),
    ('cmdb_ci',          lambda r: _v(r.get('cmdb_ci'))),
    ('caller_id',        lambda r: _v(r.get('caller_id'))),
    ('opened_at',        lambda r: _v(r.get('opened_at')) or _v(r.get('sys_created_on'))),
    ('sys_created_on',   lambda r: _v(r.get('sys_created_on'))),
    ('sys_updated_on',   lambda r: _v(r.get('sys_updated_on'))),
    ('legal_hold',       lambda r: 1 if str(_v(r.get('legal_hold')) or 'false').lower() == 'true' else 0),
    ('sys_class_name',   lambda r: _v(r.get('sys_class_name'))),
    ('parent',           lambda r: _v(r.get('parent'))),
]

USER_INDEXED_COLS = [
    ('user_name',        lambda r: _v(r.get('user_name'))),
    ('name',             lambda r: _v(r.get('name'))),
    ('email',            lambda r: _v(r.get('email'))),
    ('title',            lambda r: _v(r.get('title'))),
    ('department',       lambda r: _v(r.get('department'))),
    ('location',         lambda r: _v(r.get('location'))),
    ('active',           lambda r: 1 if str(_v(r.get('active')) or 'false').lower() == 'true' else 0),
]

CMDB_INDEXED_COLS = [
    ('name',                lambda r: _v(r.get('name'))),
    ('sys_class_name',      lambda r: _v(r.get('sys_class_name'))),
    ('operational_status',  lambda r: _v(r.get('operational_status'))),
    ('owned_by',            lambda r: _v(r.get('owned_by'))),
    ('short_description',   lambda r: _v(r.get('short_description'))),
]


# sc_req_item links upward to sc_request via `request`; sc_task links upward
# to sc_req_item via `request_item`. Without these columns indexed, the
# viewer's child-task filter (parent record → child rows) silently returned
# every row in the table.
SC_REQ_ITEM_COLS = TASK_INDEXED_COLS + [
    ('request',     lambda r: _v(r.get('request'))),
    ('cat_item',    lambda r: _v(r.get('cat_item'))),
]
SC_TASK_COLS = TASK_INDEXED_COLS + [
    ('request_item', lambda r: _v(r.get('request_item'))),
    ('request',      lambda r: _v(r.get('request'))),
]

SCHEMAS = {
    # Task descendants — the viewer's biggest lookup target. All share the same
    # base task fields, so use the same indexed-column set.
    'incident':            TASK_INDEXED_COLS,
    'change_request':      TASK_INDEXED_COLS,
    'problem':             TASK_INDEXED_COLS,
    'problem_task':        TASK_INDEXED_COLS,
    'sc_request':          TASK_INDEXED_COLS,
    'sc_req_item':         SC_REQ_ITEM_COLS,
    'sc_task':             SC_TASK_COLS,
    'incident_task':       TASK_INDEXED_COLS,
    'change_task':         TASK_INDEXED_COLS,
    'sysapproval_group':   TASK_INDEXED_COLS,
    'asset_task':          TASK_INDEXED_COLS,

    # Identity
    'sys_user':            USER_INDEXED_COLS,
    'sys_user_group':      [
        ('name',        lambda r: _v(r.get('name'))),
        ('manager',     lambda r: _v(r.get('manager'))),
        ('description', lambda r: _v(r.get('description'))),
        ('active',      lambda r: 1 if str(_v(r.get('active')) or 'false').lower() == 'true' else 0),
    ],
    'sys_user_grmember':   [
        ('group',  lambda r: _v(r.get('group'))),
        ('user',   lambda r: _v(r.get('user'))),
    ],

    # CMDB
    'cmdb_ci':             CMDB_INDEXED_COLS,
    'cmdb_rel_ci':         [
        ('parent',  lambda r: _v(r.get('parent'))),
        ('child',   lambda r: _v(r.get('child'))),
        ('type',    lambda r: _dv(r.get('type'))),
    ],

    # Reference data
    'sys_choice':          [
        ('name',     lambda r: _v(r.get('name'))),    # ServiceNow's `name` is the table the choice belongs to
        ('table',    lambda r: _v(r.get('name'))),    # alias for the viewer's `c.table` lookup
        ('element',  lambda r: _v(r.get('element'))),
        ('value',    lambda r: _v(r.get('value'))),
        ('label',    lambda r: _v(r.get('label'))),
    ],
    'core_company':        [
        ('name',  lambda r: _v(r.get('name'))),
        ('short', lambda r: _v(r.get('short'))),
    ],
    'cmn_department':      [
        ('name',         lambda r: _v(r.get('name'))),
        ('cost_center',  lambda r: _v(r.get('cost_center'))),
    ],
    'cmn_location':        [
        ('name',  lambda r: _v(r.get('name'))),
        ('city',  lambda r: _v(r.get('city'))),
        ('state', lambda r: _v(r.get('state'))),
    ],
    'cmn_cost_center':     [
        ('code', lambda r: _v(r.get('code'))),
        ('name', lambda r: _v(r.get('name'))),
    ],

    # Activity & relations
    'sys_journal_field':   [
        ('name',             lambda r: _v(r.get('name'))),         # parent table name
        ('element_id',       lambda r: _v(r.get('element_id'))),   # parent record sys_id
        ('element',          lambda r: _v(r.get('element'))),      # 'work_notes' | 'comments'
        ('value',            lambda r: _v(r.get('value'))),
        ('sys_created_by',   lambda r: _v(r.get('sys_created_by'))),
        ('sys_created_on',   lambda r: _v(r.get('sys_created_on'))),
    ],
    'sys_audit':           [
        ('tablename',        lambda r: _v(r.get('tablename'))),
        ('documentkey',      lambda r: _v(r.get('documentkey'))),  # parent record sys_id
        ('fieldname',        lambda r: _v(r.get('fieldname'))),
        ('fieldlabel',       lambda r: _v(r.get('fieldlabel'))),
        ('oldvalue',         lambda r: _v(r.get('oldvalue'))),
        ('newvalue',         lambda r: _v(r.get('newvalue'))),
        ('user',             lambda r: _v(r.get('user'))),
        ('sys_created_on',   lambda r: _v(r.get('sys_created_on'))),
    ],
    'sys_attachment':      [
        ('table_name',     lambda r: _v(r.get('table_name'))),
        ('table_sys_id',   lambda r: _v(r.get('table_sys_id'))),
        ('file_name',      lambda r: _v(r.get('file_name'))),
        ('content_type',   lambda r: _v(r.get('content_type'))),
        ('size_bytes',     lambda r: _v(r.get('size_bytes'))),
        ('sys_created_by', lambda r: _v(r.get('sys_created_by'))),
        ('sys_created_on', lambda r: _v(r.get('sys_created_on'))),
    ],
    'task_ci':             [
        ('task', lambda r: _v(r.get('task'))),
        ('ci',   lambda r: _v(r.get('ci'))),
    ],
    'task_sla':            [
        ('task',                lambda r: _v(r.get('task'))),
        ('sla_definition',      lambda r: _dv(r.get('sla_definition'))),
        ('stage',               lambda r: _v(r.get('stage'))),
        ('business_percentage', lambda r: _v(r.get('business_percentage'))),
    ],
    'sysapproval_approver':[
        ('sysapproval', lambda r: _v(r.get('sysapproval'))),
        ('approver',    lambda r: _v(r.get('approver'))),
        ('state',       lambda r: _v(r.get('state'))),
        ('sys_created_on', lambda r: _v(r.get('sys_created_on'))),
    ],

    # Catalog: definitions + per-RITM variable values. The viewer joins
    # sc_item_option_mtom → sc_item_option → item_option_new to render
    # the form fields a user typed when submitting an RITM.
    'sc_cat_item':         [
        ('name',              lambda r: _v(r.get('name'))),
        ('short_description', lambda r: _v(r.get('short_description'))),
        ('sys_class_name',    lambda r: _v(r.get('sys_class_name'))),
        ('sc_catalogs',       lambda r: _v(r.get('sc_catalogs'))),
    ],
    'item_option_new':     [
        ('name',          lambda r: _v(r.get('name'))),
        ('question_text', lambda r: _v(r.get('question_text'))),
        ('type',          lambda r: _v(r.get('type'))),
        ('cat_item',      lambda r: _v(r.get('cat_item'))),
        ('mandatory',     lambda r: 1 if str(_v(r.get('mandatory')) or 'false').lower() == 'true' else 0),
        ('order',         lambda r: _v(r.get('order'))),
        ('reference',     lambda r: _v(r.get('reference'))),  # for type=reference, the target table
    ],
    'sc_item_option':      [
        ('value',           lambda r: _v(r.get('value'))),
        ('item_option_new', lambda r: _v(r.get('item_option_new'))),
        ('cat_item',        lambda r: _v(r.get('cat_item'))),
        ('order',           lambda r: _v(r.get('order'))),
    ],
    'sc_item_option_mtom': [
        ('request_item',   lambda r: _v(r.get('request_item'))),
        ('sc_item_option', lambda r: _v(r.get('sc_item_option'))),
    ],
    'question':            [
        ('name',          lambda r: _v(r.get('name'))),
        ('question_text', lambda r: _v(r.get('question_text'))),
        ('type',          lambda r: _v(r.get('type'))),
    ],
    'question_choice':     [
        ('question', lambda r: _v(r.get('question'))),
        ('text',     lambda r: _v(r.get('text'))),
        ('value',    lambda r: _v(r.get('value'))),
        ('order',    lambda r: _v(r.get('order'))),
    ],
}


# Append-only tables don't populate sys_updated_on, so use sys_created_on
# as the delta field (matches the exporter's DELTA_FIELD).
DELTA_FIELD = {
    'sys_audit':         'sys_created_on',
    'sys_journal_field': 'sys_created_on',
}

def _delta_field(table):
    return DELTA_FIELD.get(table, 'sys_updated_on')


def _ensure_build_state_table(conn):
    """Track per-table 'last cursor' so the next run can do an incremental
    rebuild instead of dropping+recreating from scratch."""
    conn.execute('''
        CREATE TABLE IF NOT EXISTS _build_state (
            table_name      TEXT PRIMARY KEY,
            last_cursor     TEXT,
            delta_field     TEXT,
            rows_total      INTEGER,
            last_built_at   TEXT
        )
    ''')
    conn.commit()


def _read_build_state(conn, table):
    row = conn.execute(
        'SELECT last_cursor FROM _build_state WHERE table_name = ?', (table,)
    ).fetchone()
    return row['last_cursor'] if row else None


def _write_build_state(conn, table, last_cursor, delta_field, rows_total):
    conn.execute('''
        INSERT OR REPLACE INTO _build_state
            (table_name, last_cursor, delta_field, rows_total, last_built_at)
        VALUES (?, ?, ?, ?, datetime('now'))
    ''', (table, last_cursor or '', delta_field, rows_total))
    conn.commit()


def build_table(conn, table, indexed_cols, ndjson_path, force_full=False):
    """Stream NDJSON → SQLite. Incremental by default: rows whose delta-field
    value (sys_updated_on or sys_created_on) is <= the last recorded cursor
    are skipped. Force a full rebuild with `force_full=True` (or pass
    --rebuild on the CLI, which deletes the DB before this is called)."""
    print(f'[{table}]', end=' ', flush=True)
    if not ndjson_path.exists():
        print(f'no NDJSON file — skipping')
        return 0

    delta_field = _delta_field(table)
    last_cursor = None if force_full else _read_build_state(conn, table)

    # Cursor recovery: if the table already exists with rows but we have no
    # _build_state row for it (e.g. it was built by a pre-_build_state version
    # of this script), seed the cursor from MAX(delta_field) so we proceed
    # incrementally instead of dropping the existing data.
    if not last_cursor and not force_full:
        try:
            existing_count = conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        except sqlite3.OperationalError:
            existing_count = 0
        if existing_count > 0:
            recovered = conn.execute(
                f'SELECT MAX("{delta_field}") FROM "{table}"'
            ).fetchone()[0]
            last_cursor = recovered or ''
            if last_cursor:
                print(f'(recovered cursor)', end=' ', flush=True)

    # Column-drift detection. If indexed_cols added a new column that the
    # existing table doesn't have, force a full rebuild so the new column
    # gets populated for existing rows. Without this, a code change that
    # adds a filter column (e.g. sc_task.request_item) would index nothing
    # for old rows and silently break per-record filters.
    if last_cursor:
        try:
            existing_cols = {r['name'] for r in conn.execute(f'PRAGMA table_info("{table}")')}
            expected_cols = {'sys_id', 'raw'} | {n for n, _ in indexed_cols}
            missing = expected_cols - existing_cols
            if missing:
                print(f'(schema drift: +{",".join(sorted(missing))} → full rebuild)', end=' ', flush=True)
                last_cursor = None
        except sqlite3.OperationalError:
            pass  # table doesn't exist; will be created below

    incremental = bool(last_cursor)

    cur = conn.cursor()
    if incremental:
        # Schema is unchanged across versions; just ensure table exists. Don't
        # drop — keeping the existing rows lets us patch only what's new.
        print(f'(Δ since {last_cursor[:10]})', end=' ', flush=True)
    else:
        # Full build: drop + recreate.
        cols = ['"sys_id" TEXT PRIMARY KEY']
        cols += [f'"{name}" TEXT' for name, _ in indexed_cols]
        cols.append('"raw" TEXT')
        cur.execute(f'DROP TABLE IF EXISTS "{table}"')
        cur.execute(f'CREATE TABLE "{table}" ({", ".join(cols)})')

    placeholders = ', '.join(['?'] * (1 + len(indexed_cols) + 1))
    insert_sql = f'INSERT OR REPLACE INTO "{table}" VALUES ({placeholders})'

    started = time.time()
    written = skipped = 0
    new_max = last_cursor or ''
    batch = []
    BATCH_SIZE = 5000
    seen_sys_ids = set()

    with ndjson_path.open('r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            sid = _v(row.get('sys_id'))
            if not sid or sid in seen_sys_ids:
                continue
            seen_sys_ids.add(sid)

            row_cursor = _v(row.get(delta_field)) or ''
            # Incremental skip: row hasn't changed since the last build.
            # Use >= so the boundary row gets re-processed (idempotent).
            if incremental and row_cursor and row_cursor < last_cursor:
                skipped += 1
                continue

            if row_cursor and row_cursor > new_max:
                new_max = row_cursor

            values = [sid]
            for _, extractor in indexed_cols:
                try:
                    values.append(extractor(row))
                except Exception:
                    values.append(None)
            values.append(line)
            batch.append(values)
            if len(batch) >= BATCH_SIZE:
                cur.executemany(insert_sql, batch)
                written += len(batch)
                batch = []
    if batch:
        cur.executemany(insert_sql, batch)
        written += len(batch)
    conn.commit()

    # Indexes are idempotent (IF NOT EXISTS) — safe on every run.
    for col_name, _ in indexed_cols:
        try:
            cur.execute(f'CREATE INDEX IF NOT EXISTS "idx_{table}_{col_name}" ON "{table}"("{col_name}")')
        except sqlite3.Error as e:
            print(f'  (index {col_name} skipped: {e})', end='')
    conn.commit()

    # Track the cursor for next time.
    rows_total = conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
    _write_build_state(conn, table, new_max, delta_field, rows_total)

    elapsed = time.time() - started
    if incremental:
        print(f'{written:,} updated/new, {skipped:,} unchanged ({rows_total:,} total) in {elapsed:.0f}s')
    else:
        print(f'{written:,} rows in {elapsed:.0f}s')
    return written


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--rebuild', action='store_true',
                   help='Force a full rebuild — delete the DB and re-load every '
                        'row from NDJSON. Without this flag, the build is '
                        'incremental: only rows newer than each table\'s last '
                        'recorded cursor are re-processed.')
    p.add_argument('--vacuum', action='store_true',
                   help='Run VACUUM at the end (reclaims space; takes 15-25 '
                        'min on a large DB). Skipped by default; the DB '
                        'auto-vacuums incrementally and full VACUUM only '
                        'matters when the DB has shrunk substantially.')
    args = p.parse_args()

    is_full = args.rebuild
    if is_full and DB_PATH.exists():
        print(f'Removing existing {DB_PATH}')
        DB_PATH.unlink()

    mode = 'FULL (forced)' if is_full else (
        'INCREMENTAL' if DB_PATH.exists() else 'FULL (first build)'
    )
    print(f'Building {DB_PATH}  [{mode}]')
    print(f'  source NDJSON dir: {DATA}')

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode = WAL')
    conn.execute('PRAGMA synchronous = NORMAL')
    conn.execute('PRAGMA cache_size = -65536')  # 64 MB cache

    _ensure_build_state_table(conn)

    started = time.time()
    total_written = 0
    for table, indexed_cols in SCHEMAS.items():
        ndjson_path = DATA / f'{table}.ndjson'
        n = build_table(conn, table, indexed_cols, ndjson_path, force_full=is_full)
        total_written += n

    if args.vacuum:
        print('Vacuuming (this can take 15-25 minutes on a large DB)…')
        conn.execute('VACUUM')
    # Checkpoint the WAL into the main DB and switch back to delete mode so
    # the resulting file is fully self-contained. Otherwise read-only mounts
    # in the container can't open it (SQLite needs to create -shm/-wal
    # coordination files for WAL-mode DBs even on pure SELECT workloads).
    conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    conn.execute('PRAGMA journal_mode=DELETE')
    conn.close()

    size_mb = DB_PATH.stat().st_size / 1024 / 1024
    elapsed = time.time() - started
    print(f'Done in {int(elapsed)}s. {total_written:,} rows '
          f'{"loaded" if is_full else "updated/new"}. '
          f'DB size: {size_mb:.0f} MB at {DB_PATH}')


if __name__ == '__main__':
    main()
