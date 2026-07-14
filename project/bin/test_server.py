#!/usr/bin/env python3
"""Offline unit tests for task metrics and generic list drill-down filters.

Run from the repository root:

    python3 project/bin/test_server.py
"""
import io
import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

os.environ.setdefault('HISTORICALWOW_ACCESS_LOG', '')

import build_sqlite as build  # noqa: E402
import server                 # noqa: E402


def _envelope(**fields):
    return json.dumps({
        key: {'value': value, 'display_value': display}
        for key, (value, display) in fields.items()
    })


def _choice_raw(*, inactive=False, parent='', sequence=1):
    return json.dumps({
        'inactive': {'value': 'true' if inactive else 'false'},
        'dependent_value': {'value': parent},
        'sequence': {'value': str(sequence)},
    })


def _fixture():
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    conn.executescript('''
        CREATE TABLE incident (
            sys_id TEXT PRIMARY KEY,
            number TEXT,
            short_description TEXT,
            active TEXT,
            state TEXT,
            priority TEXT,
            impact TEXT,
            urgency TEXT,
            category TEXT,
            subcategory TEXT,
            contact_type TEXT,
            assignment_group TEXT,
            assigned_to TEXT,
            cmdb_ci TEXT,
            opened_at TEXT,
            raw TEXT
        );
        CREATE INDEX idx_incident_category ON incident(category);
        CREATE INDEX idx_incident_subcategory ON incident(subcategory);
        CREATE INDEX idx_incident_category_subcategory
            ON incident(category, subcategory);
        CREATE TABLE incident_task (
            sys_id TEXT PRIMARY KEY,
            parent TEXT,
            raw TEXT
        );
        CREATE TABLE sys_choice (
            sys_id TEXT PRIMARY KEY,
            name TEXT,
            element TEXT,
            value TEXT,
            label TEXT,
            raw TEXT
        );
    ''')
    rows = [
        ('a', 'INC-A', 'Laptop issue', '1', '1', '2', '2', '2',
         'hardware', 'laptop', 'email', 'group-a', 'user-a', 'ci-a',
         '2025-01-01 10:00:00',
         _envelope(
             active=('true', 'true'), state=('1', 'New'), priority=('2', 'High'),
             impact=('2', 'Medium'), urgency=('2', 'Medium'),
             category=('hardware', 'Hardware'), subcategory=('laptop', 'Laptop'),
             contact_type=('email', 'Email'), assignment_group=('group-a', 'Support'),
             assigned_to=('user-a', 'Analyst'), cmdb_ci=('ci-a', 'Device'),
         )),
        ('b', 'INC-B', 'Unclassified issue', '0', '7', '4', '3', '3',
         '', '', 'phone', '', '', '', '2025-01-02 10:00:00',
         _envelope(
             active=('false', 'false'), state=('7', 'Closed'), priority=('4', 'Low'),
             impact=('3', 'Low'), urgency=('3', 'Low'), category=('', ''),
             subcategory=('', ''), contact_type=('phone', 'Phone'),
             assignment_group=('', ''), assigned_to=('', ''), cmdb_ci=('', ''),
         )),
        ('c', 'INC-C', 'Restricted desktop issue', '1', '2', '3', '2', '2',
         'hardware', 'desktop', 'email', 'hr-test-group', 'user-b', 'ci-b',
         '2025-01-03 10:00:00',
         _envelope(
             active=('true', 'true'), state=('2', 'In progress'), priority=('3', 'Moderate'),
             impact=('2', 'Medium'), urgency=('2', 'Medium'),
             category=('hardware', 'Hardware'), subcategory=('desktop', 'Desktop'),
             contact_type=('email', 'Email'), assignment_group=('hr-test-group', 'Restricted'),
             assigned_to=('user-b', 'Other'), cmdb_ci=('ci-b', 'Other device'),
         )),
        ('d', 'INC-D', 'Historic classification', '0', '7', '4', '3', '3',
         'legacy', '', 'phone', 'group-a', '', '', '2025-01-04 10:00:00',
         _envelope(
             active=('false', 'false'), state=('7', 'Closed'), priority=('4', 'Low'),
             impact=('3', 'Low'), urgency=('3', 'Low'), category=('legacy', 'Legacy'),
             subcategory=('', ''), contact_type=('phone', 'Phone'),
             assignment_group=('group-a', 'Support'), assigned_to=('', ''), cmdb_ci=('', ''),
         )),
    ]
    conn.executemany(
        'INSERT INTO incident VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', rows
    )
    conn.executemany(
        'INSERT INTO incident_task VALUES (?,?,?)', [
            ('task-a', 'a', '{}'),
            ('task-c', 'c', '{}'),
        ]
    )
    choices = [
        ('cat-h', 'incident', 'category', 'hardware', 'Hardware',
         _choice_raw(sequence=1)),
        ('cat-s', 'incident', 'category', 'software', 'Software',
         _choice_raw(sequence=2)),
        ('cat-l', 'incident', 'category', 'legacy', 'Legacy',
         _choice_raw(inactive=True, sequence=3)),
        ('sub-l', 'incident', 'subcategory', 'laptop', 'Laptop',
         _choice_raw(parent='hardware', sequence=1)),
        ('sub-d', 'incident', 'subcategory', 'desktop', 'Desktop',
         _choice_raw(parent='hardware', sequence=2)),
        ('sub-a', 'incident', 'subcategory', 'application', 'Application',
         _choice_raw(parent='software', sequence=1)),
    ]
    conn.executemany('INSERT INTO sys_choice VALUES (?,?,?,?,?,?)', choices)
    conn.commit()
    return conn


class _Handler:
    def __init__(self):
        self.headers = {}
        self.wfile = io.BytesIO()
        self.status = None
        self.response_headers = {}

    def send_response(self, status):
        self.status = int(status)

    def send_header(self, key, value):
        self.response_headers[key] = value

    def end_headers(self):
        pass


def _payload(handler):
    return json.loads(handler.wfile.getvalue())


def test_task_metrics_used_unused_and_hr_visibility():
    conn = _fixture()
    old_group = server.HR_GROUP_SYS_ID
    server.HR_GROUP_SYS_ID = 'hr-test-group'
    try:
        locked = server._build_task_metrics_payload(conn, 'incident', False)
        unlocked = server._build_task_metrics_payload(conn, 'incident', True)
    finally:
        server.HR_GROUP_SYS_ID = old_group
    assert locked['total'] == 3, locked
    assert unlocked['total'] == 4, unlocked
    hardware = next(x for x in locked['dimensions']['category'] if x['value'] == 'hardware')
    assert hardware['label'] == 'Hardware' and hardware['count'] == 1, hardware
    assert locked['coverage']['category'] == {'set': 2, 'empty': 1}
    assert [x['value'] for x in locked['unused']['category']] == ['software']
    unused_pairs = {(x['category'], x['value']) for x in locked['unused']['subcategory']}
    assert unused_pairs == {('hardware', 'desktop'), ('software', 'application')}, unused_pairs
    assert any(x['category'] == 'hardware' and x['value'] == 'laptop'
               for x in locked['subcategory_pairs'])
    # An inactive historical code remains visible in observed usage but is not
    # misreported as an active configured choice with zero usage.
    assert any(x['value'] == 'legacy' for x in locked['dimensions']['category'])
    assert not any(x['value'] == 'legacy' for x in locked['unused']['category'])


def test_empty_filter_drills_to_null_or_empty_rows():
    conn = _fixture()
    old_conn = getattr(server._local, 'conn', None)
    old_password = server.HR_UNLOCK_PASSWORD
    server._local.conn = conn
    server.HR_UNLOCK_PASSWORD = ''
    handler = _Handler()
    try:
        server.list_table(handler, 'incident', {
            'category': [server.EMPTY_FILTER_VALUE],
            'limit': ['50'], 'slim': ['1'],
        })
    finally:
        server.HR_UNLOCK_PASSWORD = old_password
        if old_conn is None:
            delattr(server._local, 'conn')
        else:
            server._local.conn = old_conn
    body = _payload(handler)
    assert handler.status == 200
    assert body['total'] == 1, body
    assert [row['sys_id'] for row in body['rows']] == ['b']
    assert body['rows'][0]['active'] == '0'


def test_combined_search_and_category_filter_matches_list_total():
    conn = _fixture()
    old_conn = getattr(server._local, 'conn', None)
    old_password = server.HR_UNLOCK_PASSWORD
    server._local.conn = conn
    server.HR_UNLOCK_PASSWORD = ''
    handler = _Handler()
    try:
        server.list_table(handler, 'incident', {
            'q': ['Laptop'], 'category': ['hardware'], 'limit': ['50'],
        })
    finally:
        server.HR_UNLOCK_PASSWORD = old_password
        if old_conn is None:
            delattr(server._local, 'conn')
        else:
            server._local.conn = old_conn
    body = _payload(handler)
    assert body['total'] == 1, body
    assert body['rows'][0]['sys_id'] == 'a'
    assert body['rows'][0]['active'] == {
        'value': 'true', 'display_value': 'true',
    }


def test_hr_parent_lists_are_never_publicly_cached():
    conn = _fixture()
    old_conn = getattr(server._local, 'conn', None)
    old_password = server.HR_UNLOCK_PASSWORD
    old_group = server.HR_GROUP_SYS_ID
    token = 'test-unlocked-token'
    server._local.conn = conn
    server.HR_UNLOCK_PASSWORD = 'configured-for-test'
    server.HR_GROUP_SYS_ID = 'hr-test-group'
    with server._hr_tokens_lock:
        server._hr_tokens.add(token)
    try:
        handlers = [_Handler(), _Handler()]
        handlers[1].headers['Cookie'] = f'hr_unlock={token}'
        for handler in handlers:
            server.list_table(handler, 'incident_task', {'limit': ['201']})
            assert handler.response_headers['Cache-Control'] == 'no-cache, must-revalidate'
            vary = {x.strip() for x in handler.response_headers['Vary'].split(',')}
            assert vary == {'Accept-Encoding', 'Cookie'}
    finally:
        with server._hr_tokens_lock:
            server._hr_tokens.discard(token)
        server.HR_UNLOCK_PASSWORD = old_password
        server.HR_GROUP_SYS_ID = old_group
        if old_conn is None:
            delattr(server._local, 'conn')
        else:
            server._local.conn = old_conn


def test_public_list_cache_varies_on_content_encoding():
    conn = _fixture()
    old_conn = getattr(server._local, 'conn', None)
    old_password = server.HR_UNLOCK_PASSWORD
    server._local.conn = conn
    server.HR_UNLOCK_PASSWORD = ''
    handler = _Handler()
    try:
        server.list_table(handler, 'sys_choice', {'limit': ['201']})
    finally:
        server.HR_UNLOCK_PASSWORD = old_password
        if old_conn is None:
            delattr(server._local, 'conn')
        else:
            server._local.conn = old_conn
    assert handler.response_headers['Cache-Control'] == 'public, max-age=300'
    assert handler.response_headers['Vary'] == 'Accept-Encoding'


def test_subcategory_pair_query_has_covering_index():
    conn = _fixture()
    plan = conn.execute(
        'EXPLAIN QUERY PLAN SELECT category, subcategory, COUNT(*) '
        'FROM incident GROUP BY category, subcategory'
    ).fetchall()
    detail = ' '.join(str(row['detail']) for row in plan)
    assert 'idx_incident_category_subcategory' in detail, detail
    assert build.COMPOSITE_INDEXES['incident'] == [('category', 'subcategory')]


def test_build_table_extracts_analytics_columns_and_indexes():
    with tempfile.TemporaryDirectory() as td:
        ndjson = Path(td) / 'incident.ndjson'
        row = {
            'sys_id': {'value': 'one'},
            'number': {'value': 'INC-ONE'},
            'sys_updated_on': {'value': '2025-01-01 00:00:00'},
            'active': {'value': 'true'},
            'impact': {'value': '2'},
            'urgency': {'value': '3'},
            'contact_type': {'value': 'email'},
            'category': {'value': 'hardware'},
            'subcategory': {'value': 'laptop'},
        }
        ndjson.write_text(json.dumps(row) + '\n')
        conn = sqlite3.connect(':memory:')
        conn.row_factory = sqlite3.Row
        build._ensure_build_state_table(conn)
        build.build_table(
            conn, 'incident', build.SCHEMAS['incident'], ndjson,
            force_full=True, report_new_tables=False,
        )
        stored = conn.execute(
            'SELECT active, impact, urgency, contact_type, category, subcategory '
            'FROM incident WHERE sys_id = ?', ('one',),
        ).fetchone()
        assert tuple(stored) == ('1', '2', '3', 'email', 'hardware', 'laptop')
        indexes = {r['name'] for r in conn.execute('PRAGMA index_list("incident")')}
        assert 'idx_incident_category_subcategory' in indexes


def test_interrupted_schema_drift_rebuild_restarts_from_scratch():
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        ndjson = root / 'drift_task.ndjson'
        rows = [
            {
                'sys_id': {'value': 'old'},
                'sys_updated_on': {'value': '2025-01-01 00:00:00'},
                'category': {'value': 'hardware'},
            },
            {
                'sys_id': {'value': 'new'},
                'sys_updated_on': {'value': '2025-02-01 00:00:00'},
                'category': {'value': 'software'},
            },
        ]
        ndjson.write_text(''.join(json.dumps(row) + '\n' for row in rows))
        db_path = root / 'archive.db'
        old_cols = [
            ('sys_updated_on', lambda row: build._v(row.get('sys_updated_on'))),
        ]
        new_cols = old_cols + [
            ('category', lambda row: build._v(row.get('category'))),
        ]

        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        build._ensure_build_state_table(conn)
        build.build_table(
            conn, 'drift_task', old_cols, ndjson,
            force_full=True, report_new_tables=False,
        )

        def interrupt(_row):
            raise KeyboardInterrupt('simulated interrupted rebuild')

        interrupted_cols = old_cols + [('category', interrupt)]
        try:
            build.build_table(
                conn, 'drift_task', interrupted_cols, ndjson,
                report_new_tables=False,
            )
        except KeyboardInterrupt:
            pass
        else:
            raise AssertionError('expected simulated interruption')
        conn.close()

        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        assert build._read_build_state(conn, 'drift_task') is None
        build.build_table(
            conn, 'drift_task', new_cols, ndjson,
            report_new_tables=False,
        )
        restored = conn.execute(
            'SELECT sys_id, category FROM drift_task ORDER BY sys_id'
        ).fetchall()
        assert [tuple(row) for row in restored] == [
            ('new', 'software'), ('old', 'hardware'),
        ]
        assert build._read_build_state(conn, 'drift_task') == '2025-02-01 00:00:00'
        conn.close()


def _run():
    tests = sorted((name, fn) for name, fn in globals().items()
                   if name.startswith('test_') and callable(fn))
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print('[PASS] %s' % name)
        except Exception as exc:  # noqa: BLE001
            import traceback
            print('[FAIL] %s -> %s' % (name, exc))
            traceback.print_exc()
            failed += 1
    print('\n%d passed, %d failed' % (len(tests) - failed, failed))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(_run())
