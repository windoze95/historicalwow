#!/usr/bin/env python3
"""Offline HR authorization regressions; every record and file is synthetic.

Run from the repository root: python3 project/bin/test_hr_access.py
"""
import io
import json
import os
import sqlite3
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path

os.environ.setdefault('HISTORICALWOW_ACCESS_LOG', '')

import build_sqlite as build  # noqa: E402
import server  # noqa: E402


SECRET = 'SYNTHETIC-HR-PRIVATE-CONTENT'
TOKEN = 'synthetic-valid-hr-session'
LOCKED_COOKIES = ('', 'hr_unlock=forged-session')
VALID_COOKIE = 'hr_unlock=' + TOKEN


class _Handler:
    def __init__(self, cookie=''):
        self.headers = {'Cookie': cookie} if cookie else {}
        self.wfile = io.BytesIO()
        self.status = None
        self.response_headers = {}

    def send_response(self, status):
        self.status = int(status)

    def send_header(self, key, value):
        self.response_headers[key] = value

    def end_headers(self):
        pass


def _call(fn, *args, cookie=''):
    handler = _Handler(cookie)
    fn(handler, *args)
    return handler


def _body(handler):
    return json.loads(handler.wfile.getvalue())


def _private(handler):
    directives = {v.strip().lower() for v in
                  handler.response_headers.get('Cache-Control', '').split(',')}
    assert {'private', 'no-store'} <= directives, handler.response_headers
    vary = {v.strip().lower() for v in
            handler.response_headers.get('Vary', '').split(',')}
    assert 'cookie' in vary, handler.response_headers


def _no_secret(handler):
    assert SECRET.encode() not in handler.wfile.getvalue()


def _insert(conn, table, sys_id, private=False, **fields):
    # Use production column shapes, but fabricate every row locally. An
    # independent marker detects raw-envelope leaks as well as indexed fields.
    raw = fields.pop('raw', {})
    if private:
        raw['synthetic_private'] = SECRET
    values = {'sys_id': sys_id, **fields, 'raw': json.dumps(raw)}
    names = ', '.join('"%s"' % name for name in values)
    slots = ', '.join('?' for _ in values)
    conn.execute('INSERT INTO "%s" (%s) VALUES (%s)' % (table, names, slots),
                 tuple(values.values()))


def _fixture():
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    for table, fields in build.SCHEMAS.items():
        names = list(dict.fromkeys(name for name, _ in fields))
        columns = ', '.join('"%s" TEXT' % name for name in names)
        conn.execute('CREATE TABLE "%s" (sys_id TEXT PRIMARY KEY, %s, raw TEXT)'
                     % (table, columns))

    restricted = {}

    def row(table, record_id, private=False, **fields):
        if table in server.TASK_TABLES:
            fields = {'number': record_id, 'short_description': 'Audit ' + record_id,
                      'state': '1', 'priority': '3',
                      'sys_updated_on': '2026-01-01 00:00:00', **fields}
        _insert(conn, table, record_id, private, **fields)
        if private:
            restricted.setdefault(table, set()).add(record_id)

    row('incident', 'hr-incident', True, assignment_group='hr-test-group')
    row('incident', 'public-incident', assignment_group='support-group')
    row('incident', 'hr-child-incident', True,
        parent='hr-incident', assignment_group='support-group')
    # All task types inherit the common parent relation; subtype links can
    # independently refer to a different, public record.
    row('change_request', 'hr-change', True, parent='hr-incident')
    row('change_task', 'hr-change-task', True, parent='hr-change')
    row('change_task', 'public-change-task', parent='public-incident')
    row('incident_task', 'hr-incident-task', True,
        parent='hr-incident', incident='public-incident')
    row('problem', 'hr-problem', True, parent='hr-incident')
    row('problem_task', 'hr-problem-task', True, problem='hr-problem')
    row('sc_request', 'hr-request', True, parent='hr-incident')
    row('sc_request', 'public-request', parent='public-incident')
    row('sc_req_item', 'hr-ritm', True, request='hr-request')
    row('sc_req_item', 'public-ritm', request='public-request')
    row('sc_req_item', 'hr-parent-ritm', True,
        parent='hr-incident', request='public-request')
    # HR assignment itself protects non-incident task roots too.
    row('sc_req_item', 'hr-assigned-ritm', True,
        assignment_group='hr-test-group', request='public-request')
    row('sc_task', 'hr-catalog-task', True,
        request_item='hr-ritm', request='public-request')
    row('sc_task', 'hr-request-task', True,
        request_item='public-ritm', request='hr-request')
    row('sc_task', 'hr-parent-task', True,
        parent='hr-incident', request_item='public-ritm', request='public-request')
    row('sc_task', 'public-catalog-task', request_item='public-ritm')
    row('sysapproval_group', 'hr-approval-group', True, parent='hr-request')
    row('sysapproval_group', 'public-approval-group', parent='public-request')
    row('sysapproval_approver', 'hr-group-approver', True,
        sysapproval='public-incident', group='hr-approval-group')
    row('sysapproval_approver', 'hr-task-approver', True,
        sysapproval='hr-catalog-task', group='public-approval-group')
    row('sysapproval_approver', 'public-unlinked-approver', sysapproval='', group='')
    row('task_ci', 'hr-task-ci', True, task='hr-catalog-task')
    row('task_sla', 'hr-task-sla', True, task='hr-catalog-task', stage='in_progress')
    row('task_sla', 'hr-incident-sla', True, task='hr-incident', stage='completed')
    row('task_sla', 'hr-child-incident-sla', True,
        task='hr-child-incident', stage='completed')
    row('task_sla', 'public-incident-sla', task='public-incident', stage='completed')
    row('sys_journal_field', 'hr-journal', True, element_id='hr-catalog-task',
        element='comments', value=SECRET)
    row('sys_audit', 'hr-audit', True, documentkey='hr-catalog-task', newvalue=SECRET)
    row('sys_email', 'hr-email', True, instance='hr-catalog-task', subject=SECRET)
    row('sys_attachment', 'hr-task-attachment', True, table_sys_id='hr-catalog-task')
    row('sys_attachment', 'hr-email-attachment', True, table_sys_id='hr-email')
    row('sys_attachment', 'public-attachment', table_sys_id='public-incident')

    row('sc_cat_item', 'catalog-item', name='Synthetic catalog item')
    row('item_option_new', 'variable-definition', name='test_field',
        question_text='Synthetic field', type='1', order='1')
    for option, private in (('hr-option', True), ('shared-option', True),
                            ('public-option', False)):
        row('sc_item_option', option, private, value=SECRET if private else 'Public value',
            item_option_new='variable-definition', cat_item='catalog-item')
    row('sc_item_option_mtom', 'hr-variable-link', True,
        request_item='hr-ritm', sc_item_option='hr-option')
    row('sc_item_option_mtom', 'hr-shared-link', True,
        request_item='hr-ritm', sc_item_option='shared-option')
    row('sc_item_option_mtom', 'public-shared-link',
        request_item='public-ritm', sc_item_option='shared-option')
    row('sc_item_option_mtom', 'public-variable-link',
        request_item='public-ritm', sc_item_option='public-option')

    for outage, task, private in (('hr-outage', 'hr-catalog-task', True),
                                   ('public-outage', 'public-incident', False)):
        raw = {key: {'value': value, 'display_value': value} for key, value in {
            'cmdb_ci': 'synthetic-service', 'number': outage, 'type': 'Outage',
            'begin': '2026-01-01 10:00:00', 'end': '2026-01-01 11:00:00',
            'short_description': SECRET if private else 'Public outage',
        }.items()}
        row('cmdb_ci_outage', outage, private, task_number=task, raw=raw)
    conn.commit()
    return conn, restricted


@contextmanager
def _archive():
    conn, restricted = _fixture()
    saved = {key: getattr(server, key) for key in
             ('HR_UNLOCK_PASSWORD', 'HR_GROUP_SYS_ID', 'DATA_DIR')}
    old_conn = getattr(server._local, 'conn', None)
    server._local.conn = conn
    server.HR_UNLOCK_PASSWORD = 'synthetic-test-password'
    server.HR_GROUP_SYS_ID = 'hr-test-group'
    with server._hr_tokens_lock:
        server._hr_tokens.add(TOKEN)
    server._task_metrics_cache.clear()
    try:
        with tempfile.TemporaryDirectory() as directory:
            server.DATA_DIR = Path(directory).resolve()
            yield conn, restricted
    finally:
        server._task_metrics_cache.clear()
        with server._hr_tokens_lock:
            server._hr_tokens.discard(TOKEN)
        for key, value in saved.items():
            setattr(server, key, value)
        if old_conn is None:
            delattr(server._local, 'conn')
        else:
            server._local.conn = old_conn
        conn.close()


def test_locked_generic_reads_and_filters_exclude_every_hr_relation():
    with _archive() as (_, restricted):
        for cookie in LOCKED_COOKIES:
            for table, private_ids in restricted.items():
                listing = _call(server.list_table, table, {'limit': ['1000']}, cookie=cookie)
                assert listing.status == 200, (table, _body(listing))
                assert {row['sys_id'] for row in _body(listing)['rows']}.isdisjoint(private_ids), table
                _no_secret(listing)
                _private(listing)
                for record_id in private_ids:
                    detail = _call(server.get_record, table, record_id, cookie=cookie)
                    assert detail.status == 403, (table, record_id, detail.status)
                    _no_secret(detail)
                    _private(detail)
                    filtered = _call(server.list_table, table,
                                     {'sys_id': [record_id], 'limit': ['1000']}, cookie=cookie)
                    assert _body(filtered)['total'] == 0, (table, record_id)
            public = _call(server.get_record, 'incident', 'public-incident', cookie=cookie)
            assert public.status == 200
            # A group filter cannot override the server's authorization predicate.
            group = _call(server.list_table, 'incident',
                          {'assignment_group': ['hr-test-group']}, cookie=cookie)
            assert _body(group)['total'] == 0


def test_valid_cookie_permits_protected_records_without_caching_them():
    with _archive() as (_, restricted):
        for table, private_ids in restricted.items():
            listing = _call(server.list_table, table, {'limit': ['1000']}, cookie=VALID_COOKIE)
            assert listing.status == 200, table
            assert private_ids <= {row['sys_id'] for row in _body(listing)['rows']}, table
            _private(listing)
            for record_id in private_ids:
                detail = _call(server.get_record, table, record_id, cookie=VALID_COOKIE)
                assert detail.status == 200, (table, record_id)
                assert SECRET.encode() in detail.wfile.getvalue(), (table, record_id)
                _private(detail)


def test_task_search_and_metrics_match_locked_record_visibility():
    with _archive() as (conn, restricted):
        for cookie in (*LOCKED_COOKIES, VALID_COOKIE):
            unlocked = cookie == VALID_COOKIE
            search = _call(server.cross_table_search,
                           {'q': ['Audit'], 'limit': ['50']}, cookie=cookie)
            assert search.status == 200
            result_ids = {row['sys_id'] for row in _body(search)['rows']}
            for table in server.TASK_TABLES:
                hidden = restricted.get(table, set())
                assert (hidden <= result_ids) if unlocked else result_ids.isdisjoint(hidden), table
                metrics = _call(server.get_task_metrics, table, cookie=cookie)
                count = conn.execute('SELECT COUNT(*) FROM "%s"' % table).fetchone()[0]
                expected = count if unlocked else count - len(hidden)
                assert _body(metrics)['total'] == expected, (table, cookie, _body(metrics))
                _private(metrics)
            if not unlocked:
                _no_secret(search)
            _private(search)


def test_catalog_variables_hide_shared_hr_values_on_public_requests():
    with _archive():
        for cookie in LOCKED_COOKIES:
            private = _call(server.get_variables_for, 'hr-ritm', cookie=cookie)
            assert private.status == 403
            _no_secret(private)
            _private(private)
            public = _call(server.get_variables_for, 'public-ritm', cookie=cookie)
            assert public.status == 200
            assert [row['opt_sys_id'] for row in _body(public)['rows']] == ['public-option']
            _no_secret(public)
            _private(public)
        for request in ('hr-ritm', 'public-ritm'):
            unlocked = _call(server.get_variables_for, request, cookie=VALID_COOKIE)
            assert unlocked.status == 200
            assert SECRET.encode() in unlocked.wfile.getvalue()
            _private(unlocked)


def test_related_endpoints_and_outage_status_do_not_reintroduce_hr_data():
    with _archive():
        for cookie in (*LOCKED_COOKIES, VALID_COOKIE):
            unlocked = cookie == VALID_COOKIE
            for getter in (server.get_journal_for, server.get_audit_for,
                           server.get_attachments_for):
                result = _call(getter, 'hr-catalog-task', cookie=cookie)
                assert result.status == (200 if unlocked else 403), getter.__name__
                if not unlocked:
                    _no_secret(result)
                _private(result)
            status = _call(server.get_service_status, {}, cookie=cookie)
            assert status.status == 200
            assert (SECRET.encode() in status.wfile.getvalue()) == unlocked
            assert b'Public outage' in status.wfile.getvalue()
            _private(status)
            for group, expected in (
                ('hr-test-group', 1 if unlocked else 0),
                ('support-group', 2 if unlocked else 1),
            ):
                stats = _call(server.get_sla_stats, 'group', group, cookie=cookie)
                assert stats.status == 200
                assert _body(stats)['total'] == expected, (group, cookie, _body(stats))
                _private(stats)


def test_cyclic_task_relations_terminate_and_keep_public_cycles_visible():
    with _archive() as (conn, _):
        for record, parent, request_item, private in (
            ('hr-cycle-a', 'hr-cycle-b', 'hr-ritm', True),
            ('hr-cycle-b', 'hr-cycle-a', 'public-ritm', True),
            ('public-cycle-a', 'public-cycle-b', 'public-ritm', False),
            ('public-cycle-b', 'public-cycle-a', 'public-ritm', False),
        ):
            _insert(conn, 'sc_task', record, private, parent=parent,
                    request_item=request_item)
        conn.commit()
        for cookie in LOCKED_COOKIES:
            listing = _call(server.list_table, 'sc_task', {'limit': ['1000']}, cookie=cookie)
            visible = {row['sys_id'] for row in _body(listing)['rows']}
            assert {'hr-cycle-a', 'hr-cycle-b'}.isdisjoint(visible)
            assert {'public-cycle-a', 'public-cycle-b'} <= visible
            _no_secret(listing)


def test_activity_leaf_parents_and_cycles_keep_the_complete_hr_graph():
    with _archive() as (conn, _):
        # Activity rows can themselves own another archived record. Treating
        # audit/journal IDs as terminal for performance would expose this
        # audit -> task -> email -> journal -> task/RITM cycle.
        records = (
            ('change_task', 'bridge-change-task', {'parent': 'hr-audit'}),
            ('sys_email', 'bridge-email', {'instance': 'bridge-change-task'}),
            ('sys_journal_field', 'bridge-journal', {'element_id': 'bridge-email'}),
            ('sc_task', 'bridge-cycle-task',
             {'parent': 'bridge-journal', 'request_item': 'bridge-cycle-ritm'}),
            ('sc_req_item', 'bridge-cycle-ritm',
             {'parent': 'bridge-cycle-task', 'request': 'public-request'}),
            ('sys_attachment', 'bridge-attachment', {'table_sys_id': 'bridge-cycle-ritm'}),
        )
        for table, record_id, fields in records:
            _insert(conn, table, record_id, True, **fields)
        conn.commit()
        for cookie in LOCKED_COOKIES:
            for table, record_id, _ in records:
                detail = _call(server.get_record, table, record_id, cookie=cookie)
                assert detail.status == 403, (table, record_id, detail.status)
                _no_secret(detail)
                listing = _call(server.list_table, table,
                                {'sys_id': [record_id]}, cookie=cookie)
                assert _body(listing)['total'] == 0, (table, record_id)
                _no_secret(listing)
        for table, record_id, _ in records:
            unlocked = _call(server.get_record, table, record_id, cookie=VALID_COOKIE)
            assert unlocked.status == 200
            assert SECRET.encode() in unlocked.wfile.getvalue()


def _attachment_file(record_id, body=b'Synthetic public attachment', filename='file.txt'):
    path = server.DATA_DIR / 'attachments' / record_id[:2] / record_id / filename
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    return path, '/data/' + str(path.relative_to(server.DATA_DIR))


def _route(path, cookie=''):
    handler = _Handler(cookie)
    handler.path = path
    server.Handler._route(handler)
    return handler


def test_attachment_bodies_cover_hr_email_unknown_metadata_and_session_state():
    with _archive():
        paths = []
        for record in ('hr-task-attachment', 'hr-email-attachment', 'unknown-attachment'):
            _, url = _attachment_file(record, SECRET.encode())
            paths.append(url)
        _, public_url = _attachment_file('public-attachment')
        for cookie in (*LOCKED_COOKIES, VALID_COOKIE):
            unlocked = cookie == VALID_COOKIE
            for url in paths:
                result = _route(url, cookie)
                assert result.status == (200 if unlocked else 403), (url, result.status)
                assert (SECRET.encode() in result.wfile.getvalue()) == unlocked
                _private(result)
            assert _route(public_url, cookie).status == 200


def test_attachment_symlinks_cannot_bypass_hr_or_escape_attachment_root():
    with _archive():
        private_file, _ = _attachment_file('hr-email-attachment', SECRET.encode())
        public_file, public_url = _attachment_file('public-attachment')
        public_file.unlink()
        public_file.symlink_to(private_file)
        for cookie in LOCKED_COOKIES:
            result = _route(public_url, cookie)
            assert result.status == 403, result.status
            _no_secret(result)
        public_file.unlink()
        database = server.DATA_DIR / 'synthetic-private.db'
        database.write_bytes(SECRET.encode())
        public_file.symlink_to(database)
        for cookie in (*LOCKED_COOKIES, VALID_COOKIE):
            result = _route(public_url, cookie)
            assert result.status == 403, result.status
            _no_secret(result)
        traversing = '/data/attachments/pu/public-attachment/../../../synthetic-private.db'
        assert _route(traversing).status == 403


def test_active_attachment_content_is_sandboxed():
    with _archive():
        _, url = _attachment_file('public-attachment', b'<script>fetch("/api/incident")</script>',
                                  'test.html')
        result = _route(url, VALID_COOKIE)
        assert result.status == 200
        csp = result.response_headers.get('Content-Security-Policy', '')
        assert 'sandbox' in csp
        assert 'allow-scripts' not in csp and 'allow-same-origin' not in csp
        assert result.response_headers.get('X-Content-Type-Options') == 'nosniff'


def test_optional_absence_is_safe_and_present_incomplete_relation_fails_closed():
    with _archive() as (conn, _):
        conn.execute('DROP TABLE cmdb_ci_outage')
        assert _call(server.get_record, 'incident', 'public-incident').status == 200
        conn.execute('ALTER TABLE sc_task RENAME COLUMN request_item TO old_request_item')
        for getter, args in (
            (server.get_record, ('sc_task', 'hr-catalog-task')),
            (server.list_table, ('sc_task', {'limit': ['1000']})),
            (server.get_variables_for, ('hr-ritm',)),
        ):
            result = _call(getter, *args)
            assert result.status in (403, 503), (getter.__name__, result.status)
            _no_secret(result)


def test_catalog_values_stay_locked_until_ownership_tables_are_built():
    with _archive() as (conn, _):
        conn.execute('DROP TABLE sc_item_option_mtom')
        for cookie in LOCKED_COOKIES:
            for getter, args in (
                (server.get_record, ('sc_item_option', 'hr-option')),
                (server.list_table, ('sc_item_option', {'limit': ['1000']})),
            ):
                result = _call(getter, *args, cookie=cookie)
                assert result.status == 503, (getter.__name__, result.status)
                _no_secret(result)


def test_raw_archive_files_have_no_public_route():
    with _archive():
        for filename in ('historicalwow.db', 'incident.ndjson'):
            (server.DATA_DIR / filename).write_bytes(SECRET.encode())
            result = _route('/data/' + filename)
            assert result.status == 404
            _no_secret(result)


def _run():
    tests = sorted((name, fn) for name, fn in globals().items()
                   if name.startswith('test_') and callable(fn))
    failures = 0
    for name, fn in tests:
        try:
            fn()
            print('[PASS] ' + name)
        except Exception:
            import traceback
            print('[FAIL] ' + name)
            traceback.print_exc()
            failures += 1
    print('\n%d passed, %d failed' % (len(tests) - failures, failures))
    return bool(failures)


if __name__ == '__main__':
    sys.exit(_run())
