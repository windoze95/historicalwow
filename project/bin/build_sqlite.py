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


SCHEMAS = {
    # Task descendants — the viewer's biggest lookup target. All share the same
    # base task fields, so use the same indexed-column set.
    'incident':            TASK_INDEXED_COLS,
    'change_request':      TASK_INDEXED_COLS,
    'problem':             TASK_INDEXED_COLS,
    'problem_task':        TASK_INDEXED_COLS,
    'sc_request':          TASK_INDEXED_COLS,
    'sc_req_item':         TASK_INDEXED_COLS,
    'sc_task':             TASK_INDEXED_COLS,
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
}


def build_table(conn, table, indexed_cols, ndjson_path):
    """Drop + recreate `table`, stream rows from ndjson_path, INSERT them."""
    print(f'[{table}]', end=' ', flush=True)
    if not ndjson_path.exists():
        print(f'no NDJSON file — skipping')
        return 0

    # Schema: sys_id PK, indexed columns, raw blob.
    cols = ['sys_id TEXT PRIMARY KEY']
    cols += [f'{name} TEXT' for name, _ in indexed_cols]
    cols.append('raw TEXT')

    cur = conn.cursor()
    cur.execute(f'DROP TABLE IF EXISTS "{table}"')
    cur.execute(f'CREATE TABLE "{table}" ({", ".join(cols)})')

    # Insert in batches of 5000 for speed.
    placeholders = ', '.join(['?'] * (1 + len(indexed_cols) + 1))
    insert_sql = f'INSERT OR REPLACE INTO "{table}" VALUES ({placeholders})'

    started = time.time()
    written = 0
    batch = []
    BATCH_SIZE = 5000
    seen_sys_ids = set()  # de-dup within a single run; the NDJSON merge already
                          # handles cross-run dedupe but defensively ignore dupes

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
            values = [sid]
            for _, extractor in indexed_cols:
                try:
                    values.append(extractor(row))
                except Exception:
                    values.append(None)
            values.append(line)  # raw is the original NDJSON line (envelope intact)
            batch.append(values)
            if len(batch) >= BATCH_SIZE:
                cur.executemany(insert_sql, batch)
                written += len(batch)
                batch = []
    if batch:
        cur.executemany(insert_sql, batch)
        written += len(batch)
    conn.commit()

    # Indexes for the indexed columns we just wrote.
    for col_name, _ in indexed_cols:
        try:
            cur.execute(f'CREATE INDEX IF NOT EXISTS "idx_{table}_{col_name}" ON "{table}"("{col_name}")')
        except sqlite3.Error as e:
            print(f'  (index {col_name} skipped: {e})', end='')
    conn.commit()

    elapsed = time.time() - started
    print(f'{written:,} rows in {elapsed:.0f}s')
    return written


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--rebuild', action='store_true',
                   help='Delete and recreate the DB file (default: append/replace per table).')
    args = p.parse_args()

    if args.rebuild and DB_PATH.exists():
        print(f'Removing existing {DB_PATH}')
        DB_PATH.unlink()

    print(f'Building {DB_PATH}')
    print(f'  source NDJSON dir: {DATA}')

    conn = sqlite3.connect(DB_PATH)
    conn.execute('PRAGMA journal_mode = WAL')
    conn.execute('PRAGMA synchronous = NORMAL')
    conn.execute('PRAGMA cache_size = -65536')  # 64 MB cache

    total_rows = 0
    for table, indexed_cols in SCHEMAS.items():
        ndjson_path = DATA / f'{table}.ndjson'
        n = build_table(conn, table, indexed_cols, ndjson_path)
        total_rows += n

    # Vacuum to compact (large dataset, reclaims a lot)
    print('Vacuuming…')
    conn.execute('VACUUM')
    conn.close()

    size_mb = DB_PATH.stat().st_size / 1024 / 1024
    print(f'Done. {total_rows:,} rows total. DB size: {size_mb:.0f} MB at {DB_PATH}')


if __name__ == '__main__':
    main()
