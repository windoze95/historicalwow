#!/usr/bin/env python3
"""
Self-contained tests for historicalwow_export.py — exercises the file I/O,
state, and delta-merge logic against a temp dir. The HTTP layer is stubbed.

Run: python3 test_exporter.py
"""
import json
import io
import os
import sys
import tempfile
import urllib.error
from pathlib import Path

# Required env vars are validated at import time; set dummies first.
os.environ.setdefault('SN_INSTANCE',      'test.service-now.com')
os.environ.setdefault('SN_CLIENT_ID',     'test-client-id')
os.environ.setdefault('SN_CLIENT_SECRET', 'test-client-secret')
os.environ.setdefault('SN_USERNAME',      'test-user')
os.environ.setdefault('SN_PASSWORD',      'test-pass')

sys.path.insert(0, str(Path(__file__).resolve().parent))
import historicalwow_export as ex


# ---- fixture helpers -------------------------------------------------------

def _row(sys_id, **fields):
    """Build a row in ServiceNow's sysparm_display_value=all envelope shape."""
    out = {'sys_id': {'value': sys_id, 'display_value': sys_id}}
    for k, v in fields.items():
        out[k] = {'value': v, 'display_value': str(v)}
    return out


def _write_ndjson(path, rows):
    with open(path, 'w', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps(r) + '\n')


def _read_ndjson(path):
    with open(path, 'r', encoding='utf-8') as f:
        return [json.loads(line) for line in f if line.strip()]


# ---- tests -----------------------------------------------------------------

def test_field_envelope_unwrap():
    r = _row('abc', sys_updated_on='2026-04-30 10:00:00')
    assert ex.field(r, 'sys_id') == 'abc'
    assert ex._extract_sid(r) == 'abc'
    assert ex._extract_updated(r) == '2026-04-30 10:00:00'
    # Plain scalar passes through unchanged
    assert ex.field({'plain': 'x'}, 'plain') == 'x'
    # Missing key returns None
    assert ex.field({}, 'absent') is None


def test_count_lines_and_last_sys_id():
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / 'x.ndjson'
        _write_ndjson(p, [_row('a'), _row('b'), _row('c')])
        assert ex._count_lines(p) == 3
        assert ex._last_sys_id_in_file(p) == 'c'

        # missing file
        assert ex._count_lines(Path(td) / 'absent.ndjson') == 0
        assert ex._last_sys_id_in_file(Path(td) / 'absent.ndjson') is None

        # empty file
        empty = Path(td) / 'empty.ndjson'
        empty.touch()
        assert ex._count_lines(empty) == 0
        assert ex._last_sys_id_in_file(empty) is None


def test_max_updated_in_file():
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / 'x.ndjson'
        _write_ndjson(p, [
            _row('a', sys_updated_on='2026-01-01 00:00:00'),
            _row('b', sys_updated_on='2026-04-30 12:34:56'),
            _row('c', sys_updated_on='2026-03-15 08:00:00'),
        ])
        assert ex._max_updated_in_file(p) == '2026-04-30 12:34:56'


def test_state_roundtrip():
    with tempfile.TemporaryDirectory() as td:
        ex.OUT_DIR    = Path(td)
        ex.STATE_PATH = Path(td) / '_state.json'

        s = ex.read_state()
        assert s == {'version': 1, 'watermarks': {}}

        s['watermarks']['incident'] = '2026-04-30 12:00:00'
        ex.write_state(s)
        assert ex.STATE_PATH.exists()

        s2 = ex.read_state()
        assert s2['watermarks']['incident'] == '2026-04-30 12:00:00'
        assert 'updated_at' in s2


def test_safe_name():
    assert ex._safe_name('foo.txt') == 'foo.txt'
    # Path separators and other unsafe chars become _
    assert ex._safe_name('foo/bar.txt') == 'foo_bar.txt'
    assert ex._safe_name('a b c.txt') == 'a_b_c.txt'
    assert ex._safe_name('report😀.txt') == 'report_.txt'
    # Bad/empty inputs
    assert ex._safe_name(None) == 'file'
    assert ex._safe_name('') == 'file'
    # Length cap
    assert len(ex._safe_name('a' * 300)) == 200


def _http_error(code, message):
    body = json.dumps({'error': {'message': message, 'detail': None}})
    error = urllib.error.HTTPError(
        'https://test.invalid', code, message, {}, io.BytesIO(body.encode()),
    )
    error.historicalwow_body = body
    return error


def test_keyset_pagination_continues_after_short_pages():
    """ACL/byte-capped short pages are not end-of-results."""
    pages = [
        [
            _row('a', sys_updated_on='2026-04-30 10:00:00'),
            _row('b', sys_updated_on='2026-04-30 10:00:00'),
        ],
        [
            _row('c', sys_updated_on='2026-04-30 10:00:00'),
            _row('a', sys_updated_on='2026-04-30 11:00:00'),
        ],
        [],
    ]
    calls = []
    original_get = ex.api_get_json
    original_size = ex.PAGE_SIZE

    def fake_get(path, params):
        calls.append((path, dict(params)))
        return {'result': pages[len(calls) - 1]}

    ex.api_get_json = fake_get
    ex.PAGE_SIZE = 5
    try:
        rows = [
            row
            for page in ex.fetch_pages_keyset(
                'test_table', 'active=true', '2026-04-30 00:00:00',
            )
            for row in page
        ]
    finally:
        ex.api_get_json = original_get
        ex.PAGE_SIZE = original_size

    assert [ex._extract_sid(row) for row in rows] == ['a', 'b', 'c', 'a']
    assert len(calls) == 3, 'short pages must continue until an empty page'
    first = calls[0][1]
    second = calls[1][1]
    assert first['sysparm_suppress_pagination_header'] == 'true'
    assert 'sysparm_offset' not in first
    assert first['sysparm_query'] == (
        'active=true^sys_updated_on>=2026-04-30 00:00:00^'
        'ORDERBYsys_updated_on^ORDERBYsys_id'
    )
    assert second['sysparm_query'] == (
        'active=true^sys_updated_on>2026-04-30 10:00:00^NQ'
        'active=true^sys_updated_on=2026-04-30 10:00:00^sys_id>b^'
        'ORDERBYsys_updated_on^ORDERBYsys_id'
    )


def test_keyset_pagination_propagates_non_table_400():
    original_get = ex.api_get_json
    ex.api_get_json = lambda path, params: (_ for _ in ()).throw(
        _http_error(400, 'Pagination not supported')
    )
    try:
        try:
            list(ex.fetch_pages_keyset(
                'sys_journal_field', '', '2026-04-30 00:00:00',
            ))
        except urllib.error.HTTPError as error:
            assert error.code == 400
        else:
            raise AssertionError('pagination 400 must abort the table export')
    finally:
        ex.api_get_json = original_get


def test_keyset_delta_propagates_exact_invalid_table_400():
    original_get = ex.api_get_json
    ex.api_get_json = lambda path, params: (_ for _ in ()).throw(
        _http_error(400, 'Invalid table optional_table')
    )
    try:
        try:
            list(ex.fetch_pages_keyset(
                'optional_table', '', '2026-04-30 00:00:00',
            ))
        except urllib.error.HTTPError as error:
            assert error.code == 400
        else:
            raise AssertionError('a missing delta table must abort')
    finally:
        ex.api_get_json = original_get


def test_keyset_pagination_rejects_missing_table_after_first_page():
    calls = 0
    original_get = ex.api_get_json

    def fake_get(path, params):
        nonlocal calls
        calls += 1
        if calls == 1:
            return {'result': [
                _row('a', sys_updated_on='2026-04-30 10:00:00'),
            ]}
        raise _http_error(400, 'Invalid table incident')

    ex.api_get_json = fake_get
    try:
        try:
            list(ex.fetch_pages_keyset(
                'incident', '', '2026-04-30 00:00:00',
            ))
        except urllib.error.HTTPError as error:
            assert error.code == 400
        else:
            raise AssertionError('missing-table response after data must abort')
    finally:
        ex.api_get_json = original_get


def test_keyset_pagination_requires_explicit_result_field():
    original_get = ex.api_get_json
    ex.api_get_json = lambda path, params: {'status': 'success'}
    try:
        try:
            list(ex.fetch_pages_keyset(
                'incident', '', '2026-04-30 00:00:00',
            ))
        except RuntimeError as error:
            assert 'missing the result field' in str(error)
        else:
            raise AssertionError('ambiguous 200 response must abort')
    finally:
        ex.api_get_json = original_get


def test_keyset_pagination_rejects_non_advancing_cursor():
    row = _row('a', sys_updated_on='2026-04-30 10:00:00')
    original_get = ex.api_get_json
    ex.api_get_json = lambda path, params: {'result': [row]}
    try:
        try:
            list(ex.fetch_pages_keyset(
                'test_table', '', '2026-04-30 00:00:00',
            ))
        except RuntimeError as error:
            assert 'cursor did not advance' in str(error)
        else:
            raise AssertionError('a repeated cursor must abort instead of loop')
    finally:
        ex.api_get_json = original_get


def test_keyset_pagination_rejects_replayed_page_prefix():
    pages = [
        {'result': [_row('a', sys_updated_on='2026-04-30 10:00:00')]},
        {'result': [
            _row('a', sys_updated_on='2026-04-30 10:00:00'),
            _row('b', sys_updated_on='2026-04-30 11:00:00'),
        ]},
    ]
    calls = 0
    original_get = ex.api_get_json

    def fake_get(path, params):
        nonlocal calls
        payload = pages[calls]
        calls += 1
        return payload

    ex.api_get_json = fake_get
    try:
        try:
            list(ex.fetch_pages_keyset(
                'incident', '', '2026-04-30 00:00:00',
            ))
        except RuntimeError as error:
            assert 'cursor did not advance' in str(error)
        else:
            raise AssertionError('a replayed page prefix must abort')
    finally:
        ex.api_get_json = original_get


def test_keyset_pagination_rejects_rows_before_watermark():
    original_get = ex.api_get_json
    ex.api_get_json = lambda path, params: {'result': [
        _row('a', sys_updated_on='2026-04-29 23:59:59'),
    ]}
    try:
        try:
            list(ex.fetch_pages_keyset(
                'incident', '', '2026-04-30 00:00:00',
            ))
        except RuntimeError as error:
            assert 'before its delta watermark' in str(error)
        else:
            raise AssertionError('a page before the watermark must abort')
    finally:
        ex.api_get_json = original_get


def test_keyset_pagination_applies_fence_to_every_cursor_branch():
    calls = []
    original_get = ex.api_get_json

    def fake_get(path, params):
        calls.append(dict(params))
        if len(calls) == 1:
            return {'result': [
                _row('a', sys_updated_on='2026-04-30 10:00:00'),
            ]}
        return {'result': []}

    ex.api_get_json = fake_get
    try:
        list(ex.fetch_pages_keyset(
            'incident', 'active=true', '2026-04-30 00:00:00',
            '2026-04-30 12:00:00',
        ))
    finally:
        ex.api_get_json = original_get

    assert calls[0]['sysparm_query'] == (
        'active=true^sys_updated_on>=2026-04-30 00:00:00^'
        'sys_updated_on<=2026-04-30 12:00:00^'
        'ORDERBYsys_updated_on^ORDERBYsys_id'
    )
    second = calls[1]['sysparm_query']
    assert second.count('sys_updated_on<=2026-04-30 12:00:00') == 2
    assert '^NQ' in second


def test_keyset_pagination_rejects_row_beyond_fence():
    original_get = ex.api_get_json
    ex.api_get_json = lambda path, params: {'result': [
        _row('a', sys_updated_on='2026-04-30 12:00:01'),
    ]}
    try:
        try:
            list(ex.fetch_pages_keyset(
                'incident', '', '2026-04-30 00:00:00',
                '2026-04-30 12:00:00',
            ))
        except RuntimeError as error:
            assert 'beyond its delta fence' in str(error)
        else:
            raise AssertionError('a row beyond the scan fence must abort')
    finally:
        ex.api_get_json = original_get


def test_capture_delta_fence_uses_newest_visible_append_only_row():
    calls = []
    original_get = ex.api_get_json

    def fake_get(path, params):
        calls.append((path, dict(params)))
        return {'result': [
            _row('a', sys_created_on='2026-04-30 10:00:00'),
            _row('b', sys_created_on='2026-04-30 12:00:00'),
        ]}

    ex.api_get_json = fake_get
    try:
        fence = ex._capture_delta_fence(
            'sys_audit', 'tablenameINincident,problem',
        )
    finally:
        ex.api_get_json = original_get

    assert fence == '2026-04-30 12:00:00'
    assert calls[0][0] == '/api/now/table/sys_audit'
    params = calls[0][1]
    assert params['sysparm_limit'] == 2000
    assert params['sysparm_fields'] == 'sys_id,sys_created_on'
    assert params['sysparm_query'] == (
        'tablenameINincident,problem^sys_created_onISNOTEMPTY^'
        'ORDERBYDESCsys_created_on^ORDERBYDESCsys_id'
    )


def test_delta_fetch_failure_leaves_snapshot_untouched():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR = td_path
        out_path = td_path / 'incident.ndjson'
        _write_ndjson(out_path, [
            _row('inc1', sys_updated_on='2026-04-29 10:00:00'),
        ])
        before = out_path.read_bytes()
        original_pages = ex.fetch_pages_keyset
        original_fence = ex._capture_delta_fence

        def partial_then_fail(table, query, watermark, fence=None):
            yield [_row('inc2', sys_updated_on='2026-04-30 10:00:00')]
            raise _http_error(400, 'Pagination not supported')

        ex.fetch_pages_keyset = partial_then_fail
        ex._capture_delta_fence = lambda table, query='': '2026-04-30 10:00:00'
        try:
            try:
                ex.export_table_delta('incident', '2026-04-30 00:00:00')
            except urllib.error.HTTPError as error:
                assert error.code == 400
            else:
                raise AssertionError('a later-page failure must abort the merge')
        finally:
            ex.fetch_pages_keyset = original_pages
            ex._capture_delta_fence = original_fence
        assert out_path.read_bytes() == before
        assert not list(td_path.glob('.incident.delta.*'))
        assert not (td_path / 'incident.ndjson.tmp').exists()


def test_parallel_delta_is_atomic_across_shard_failure():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR = td_path
        out_path = td_path / 'sys_audit.ndjson'
        _write_ndjson(out_path, [
            _row('old', sys_created_on='2026-04-29 10:00:00'),
        ])
        before = out_path.read_bytes()
        original_pages = ex.fetch_pages_keyset
        original_fence = ex._capture_delta_fence
        original_workers = ex.PARALLEL_WORKERS

        def shard_pages(table, query, watermark, fence=None):
            prefix = query.split('sys_idSTARTSWITH', 1)[1][0]
            yield [_row(f'{prefix}1', sys_created_on='2026-04-30 10:00:00')]
            if prefix == 'f':
                raise _http_error(400, 'Pagination not supported')

        ex.fetch_pages_keyset = shard_pages
        ex._capture_delta_fence = lambda table, query='': '2026-04-30 10:00:00'
        ex.PARALLEL_WORKERS = 4
        try:
            try:
                ex.export_table_delta_parallel(
                    'sys_audit', '2026-04-30 00:00:00',
                )
            except urllib.error.HTTPError as error:
                assert error.code == 400
            else:
                raise AssertionError('one failed shard must abort the whole merge')
        finally:
            ex.fetch_pages_keyset = original_pages
            ex._capture_delta_fence = original_fence
            ex.PARALLEL_WORKERS = original_workers
        assert out_path.read_bytes() == before
        assert not list(td_path.glob('.sys_audit.delta.*'))
        assert not (td_path / 'sys_audit.ndjson.tmp').exists()


def test_parallel_delta_is_atomic_when_one_shard_is_missing():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR = td_path
        out_path = td_path / 'sys_audit.ndjson'
        _write_ndjson(out_path, [
            _row('old', sys_created_on='2026-04-29 10:00:00'),
        ])
        before = out_path.read_bytes()
        original_pages = ex.fetch_pages_keyset
        original_fence = ex._capture_delta_fence
        original_workers = ex.PARALLEL_WORKERS

        def shard_pages(table, query, watermark, fence=None):
            prefix = query.split('sys_idSTARTSWITH', 1)[1][0]
            if prefix == 'f':
                raise _http_error(400, 'Invalid table sys_audit')
            yield [_row(f'{prefix}1', sys_created_on='2026-04-30 10:00:00')]

        ex.fetch_pages_keyset = shard_pages
        ex._capture_delta_fence = lambda table, query='': '2026-04-30 10:00:00'
        ex.PARALLEL_WORKERS = 4
        try:
            try:
                ex.export_table_delta_parallel(
                    'sys_audit', '2026-04-30 00:00:00',
                )
            except urllib.error.HTTPError as error:
                assert error.code == 400
            else:
                raise AssertionError('one missing shard must abort the whole merge')
        finally:
            ex.fetch_pages_keyset = original_pages
            ex._capture_delta_fence = original_fence
            ex.PARALLEL_WORKERS = original_workers
        assert out_path.read_bytes() == before
        assert not list(td_path.glob('.sys_audit.delta.*'))


def test_delta_merge_replaces_updates_and_appends_new():
    """Core merge case: an existing file plus a delta containing one updated
    row and one brand-new row should produce a file with the unchanged rows
    intact, the updated row's contents replaced, and the new row appended."""
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR    = td_path
        ex.STATE_PATH = td_path / '_state.json'
        out_path = td_path / 'incident.ndjson'

        # Existing snapshot: 3 incidents
        _write_ndjson(out_path, [
            _row('inc1', sys_updated_on='2026-04-29 10:00:00', state='1'),
            _row('inc2', sys_updated_on='2026-04-29 11:00:00', state='1'),
            _row('inc3', sys_updated_on='2026-04-29 12:00:00', state='2'),
        ])

        # Delta: inc2 updated (state '1' → '6'), inc4 new
        delta_rows = [
            _row('inc2', sys_updated_on='2026-04-30 09:00:00', state='6'),
            _row('inc4', sys_updated_on='2026-04-30 09:30:00', state='1'),
        ]
        original_pages = ex.fetch_pages_keyset
        original_fence = ex._capture_delta_fence
        ex.fetch_pages_keyset = (
            lambda table, query, watermark, fence=None: iter([delta_rows])
        )
        ex._capture_delta_fence = lambda table, query='': '2026-04-30 09:30:00'
        try:
            rows_total, watermark = ex.export_table_delta(
                'incident', '2026-04-30 00:00:00',
            )
        finally:
            ex.fetch_pages_keyset = original_pages
            ex._capture_delta_fence = original_fence

        assert rows_total == 4, f'expected 4 rows total, got {rows_total}'
        assert watermark == '2026-04-30 09:30:00', \
            f'expected watermark to advance to max delta, got {watermark}'

        result = _read_ndjson(out_path)
        sids = [ex._extract_sid(r) for r in result]
        assert sids == ['inc1', 'inc2', 'inc3', 'inc4'], \
            f'expected unchanged-rows-first then new appended, got {sids}'

        # inc2 should now have state=6 (was 1)
        inc2 = next(r for r in result if ex._extract_sid(r) == 'inc2')
        assert ex.field(inc2, 'state') == '6', \
            f'inc2 state not updated: {ex.field(inc2, "state")}'

        # inc1 and inc3 should be untouched
        inc1 = next(r for r in result if ex._extract_sid(r) == 'inc1')
        inc3 = next(r for r in result if ex._extract_sid(r) == 'inc3')
        assert ex.field(inc1, 'sys_updated_on') == '2026-04-29 10:00:00'
        assert ex.field(inc3, 'sys_updated_on') == '2026-04-29 12:00:00'


def test_delta_no_changes_leaves_everything_alone():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR    = td_path
        ex.STATE_PATH = td_path / '_state.json'
        out_path = td_path / 'incident.ndjson'

        original = [_row('inc1', sys_updated_on='2026-04-29 10:00:00')]
        _write_ndjson(out_path, original)
        original_bytes = out_path.read_bytes()

        original_pages = ex.fetch_pages_keyset
        original_fence = ex._capture_delta_fence
        ex.fetch_pages_keyset = (
            lambda table, query, watermark, fence=None: iter([])
        )
        ex._capture_delta_fence = lambda table, query='': '2026-04-30 00:00:00'
        try:
            rows_total, watermark = ex.export_table_delta(
                'incident', '2026-04-30 00:00:00',
            )
        finally:
            ex.fetch_pages_keyset = original_pages
            ex._capture_delta_fence = original_fence

        assert rows_total == 1
        assert watermark == '2026-04-30 00:00:00', 'watermark must not regress when no delta'
        assert out_path.read_bytes() == original_bytes, 'file should be untouched'


def test_delta_no_changes_advances_only_to_prescan_fence():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR = td_path
        out_path = td_path / 'incident.ndjson'
        _write_ndjson(out_path, [
            _row('inc1', sys_updated_on='2026-04-29 10:00:00'),
        ])
        original_pages = ex.fetch_pages_keyset
        original_fence = ex._capture_delta_fence
        seen = []

        def no_pages(table, query, watermark, fence=None):
            seen.append((watermark, fence))
            return iter([])

        ex.fetch_pages_keyset = no_pages
        ex._capture_delta_fence = (
            lambda table, query='': '2026-04-30 12:00:00'
        )
        try:
            total, watermark = ex.export_table_delta(
                'incident', '2026-04-30 00:00:00',
            )
        finally:
            ex.fetch_pages_keyset = original_pages
            ex._capture_delta_fence = original_fence

        assert total == 1
        assert watermark == '2026-04-30 12:00:00'
        assert seen == [
            ('2026-04-30 00:00:00', '2026-04-30 12:00:00'),
        ]


def test_empty_acl_fence_scans_unbounded_without_advancing_state():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR = td_path
        out_path = td_path / 'incident.ndjson'
        _write_ndjson(out_path, [
            _row('old', sys_updated_on='2026-04-29 10:00:00'),
        ])
        original_pages = ex.fetch_pages_keyset
        original_fence = ex._capture_delta_fence
        seen_fences = []

        def pages(table, query, watermark, fence=None):
            seen_fences.append(fence)
            return iter([[
                _row('new', sys_updated_on='2026-04-30 12:00:00'),
            ]])

        ex.fetch_pages_keyset = pages
        ex._capture_delta_fence = lambda table, query='': ''
        try:
            total, watermark = ex.export_table_delta(
                'incident', '2026-04-30 00:00:00',
            )
        finally:
            ex.fetch_pages_keyset = original_pages
            ex._capture_delta_fence = original_fence

        assert total == 2
        assert watermark == '2026-04-30 00:00:00'
        assert seen_fences == [None]
        assert {ex._extract_sid(row) for row in _read_ndjson(out_path)} == {
            'old', 'new',
        }


def test_parallel_delta_shares_one_prescan_fence_across_all_shards():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR = td_path
        _write_ndjson(td_path / 'sys_audit.ndjson', [
            _row('old', sys_created_on='2026-04-29 10:00:00'),
        ])
        original_pages = ex.fetch_pages_keyset
        original_fence = ex._capture_delta_fence
        original_workers = ex.PARALLEL_WORKERS
        captures = []
        seen = []

        def capture(table, query=''):
            captures.append((table, query))
            return '2026-04-30 12:00:00'

        def no_pages(table, query, watermark, fence=None):
            prefix = query.split('sys_idSTARTSWITH', 1)[1][0]
            seen.append((prefix, fence))
            return iter([])

        ex._capture_delta_fence = capture
        ex.fetch_pages_keyset = no_pages
        ex.PARALLEL_WORKERS = 4
        try:
            total, watermark = ex.export_table_delta_parallel(
                'sys_audit', '2026-04-30 00:00:00',
            )
        finally:
            ex.fetch_pages_keyset = original_pages
            ex._capture_delta_fence = original_fence
            ex.PARALLEL_WORKERS = original_workers

        assert total == 1
        assert watermark == '2026-04-30 12:00:00'
        assert len(captures) == 1
        assert sorted(prefix for prefix, _ in seen) == list('0123456789abcdef')
        assert {fence for _, fence in seen} == {'2026-04-30 12:00:00'}


def test_parallel_empty_acl_fence_scans_unbounded_without_advancing_state():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR = td_path
        _write_ndjson(td_path / 'sys_audit.ndjson', [
            _row('old', sys_created_on='2026-04-29 10:00:00'),
        ])
        original_pages = ex.fetch_pages_keyset
        original_fence = ex._capture_delta_fence
        original_workers = ex.PARALLEL_WORKERS
        seen = []

        def pages(table, query, watermark, fence=None):
            prefix = query.split('sys_idSTARTSWITH', 1)[1][0]
            seen.append((prefix, fence))
            if prefix == 'a':
                return iter([[
                    _row('a-new', sys_created_on='2026-04-30 12:00:00'),
                ]])
            return iter([])

        ex.fetch_pages_keyset = pages
        ex._capture_delta_fence = lambda table, query='': ''
        ex.PARALLEL_WORKERS = 4
        try:
            total, watermark = ex.export_table_delta_parallel(
                'sys_audit', '2026-04-30 00:00:00',
            )
        finally:
            ex.fetch_pages_keyset = original_pages
            ex._capture_delta_fence = original_fence
            ex.PARALLEL_WORKERS = original_workers

        assert total == 2
        assert watermark == '2026-04-30 00:00:00'
        assert sorted(prefix for prefix, _ in seen) == list('0123456789abcdef')
        assert {fence for _, fence in seen} == {None}


def test_delta_paginated_across_multiple_pages():
    """fetch_pages_keyset returns a generator of pages; merge should work
    when the delta arrives across multiple pages."""
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR    = td_path
        ex.STATE_PATH = td_path / '_state.json'
        out_path = td_path / 'incident.ndjson'

        _write_ndjson(out_path, [
            _row('inc1', sys_updated_on='2026-04-29 10:00:00', state='1'),
        ])

        # Delta spread across two pages
        page1 = [_row('inc1', sys_updated_on='2026-04-30 10:00:00', state='2')]
        page2 = [_row('inc2', sys_updated_on='2026-04-30 11:00:00', state='1')]
        original_pages = ex.fetch_pages_keyset
        original_fence = ex._capture_delta_fence
        ex.fetch_pages_keyset = (
            lambda table, query, watermark, fence=None: iter([page1, page2])
        )
        ex._capture_delta_fence = lambda table, query='': '2026-04-30 11:00:00'
        try:
            rows_total, watermark = ex.export_table_delta(
                'incident', '2026-04-30 00:00:00',
            )
        finally:
            ex.fetch_pages_keyset = original_pages
            ex._capture_delta_fence = original_fence

        assert rows_total == 2
        assert watermark == '2026-04-30 11:00:00'

        result = _read_ndjson(out_path)
        sids = [ex._extract_sid(r) for r in result]
        assert sids == ['inc1', 'inc2']
        assert ex.field(result[0], 'state') == '2'


def test_delta_with_row_lacking_cursor_fails_without_touching_snapshot():
    """A malformed delta must not merge or silently preserve its watermark."""
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR    = td_path
        ex.STATE_PATH = td_path / '_state.json'
        out_path = td_path / 'incident.ndjson'

        _write_ndjson(out_path, [_row('inc1', sys_updated_on='2026-04-29 10:00:00')])

        # Bare row (no sys_updated_on)
        bad = {'sys_id': {'value': 'inc2', 'display_value': 'inc2'}}
        original_pages = ex.fetch_pages_keyset
        original_fence = ex._capture_delta_fence
        ex.fetch_pages_keyset = (
            lambda table, query, watermark, fence=None: iter([[bad]])
        )
        ex._capture_delta_fence = lambda table, query='': '2026-04-30 10:00:00'

        before = out_path.read_bytes()
        try:
            try:
                ex.export_table_delta('incident', '2026-04-30 00:00:00')
            except RuntimeError as error:
                assert 'missing its cursor field' in str(error)
            else:
                raise AssertionError('malformed delta row must abort the table')
        finally:
            ex.fetch_pages_keyset = original_pages
            ex._capture_delta_fence = original_fence
        assert out_path.read_bytes() == before
        assert not list(td_path.glob('.incident.delta.*'))


def test_parallel_merge_concatenates_shards_in_order():
    """export_table_parallel runs each hex-prefix shard, then concatenates
    the per-shard NDJSON files into the final <table>.ndjson and reports
    the pre-scan watermark fence shared by all shards."""
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR    = td_path
        ex.STATE_PATH = td_path / '_state.json'

        # Stub _fetch_shard so we don't hit the network. Each shard returns
        # one row with predictable sys_updated_on.
        def fake_fetch_shard(table, prefix):
            shard_path = td_path / f'{table}.shard{prefix}.ndjson'
            row = _row(f'{prefix}-id', sys_updated_on=f'2026-04-{int(prefix, 16) + 1:02d} 00:00:00')
            with shard_path.open('w') as f:
                f.write(json.dumps(row) + '\n')
            return 1, f'2026-04-{int(prefix, 16) + 1:02d} 00:00:00'

        original = ex._fetch_shard
        original_available = ex._table_available
        original_fence = ex._capture_delta_fence
        ex._fetch_shard = fake_fetch_shard
        ex._table_available = lambda table: True
        ex._capture_delta_fence = lambda table, query='': '2026-04-16 00:00:00'
        try:
            total, watermark = ex.export_table_parallel('sys_audit')
        finally:
            ex._fetch_shard = original
            ex._table_available = original_available
            ex._capture_delta_fence = original_fence

        # 16 hex prefixes × 1 row each = 16 rows
        assert total == 16
        # Max watermark = highest day (prefix 'f' → day 16)
        assert watermark == '2026-04-16 00:00:00'

        # Final file should exist with 16 lines, shards cleaned up
        out = td_path / 'sys_audit.ndjson'
        assert out.exists()
        assert _count_lines_in_file(out) == 16
        # No leftover shard files
        leftover = list(td_path.glob('sys_audit.shard*.ndjson'))
        assert leftover == [], f'shard files not cleaned up: {leftover}'


def test_parallel_full_failure_preserves_existing_snapshot():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR = td_path
        out_path = td_path / 'sys_audit.ndjson'
        _write_ndjson(out_path, [
            _row('old', sys_created_on='2026-04-29 10:00:00'),
        ])
        before = out_path.read_bytes()
        original_fetch = ex._fetch_shard
        original_available = ex._table_available
        original_fence = ex._capture_delta_fence

        def fake_fetch_shard(table, prefix):
            if prefix == 'f':
                raise _http_error(400, 'Pagination not supported')
            _write_ndjson(
                td_path / f'{table}.shard{prefix}.ndjson',
                [_row(f'{prefix}-new', sys_created_on='2026-04-30 00:00:00')],
            )
            return 1, '2026-04-30 00:00:00'

        ex._fetch_shard = fake_fetch_shard
        ex._table_available = lambda table: True
        ex._capture_delta_fence = lambda table, query='': '2026-04-30 00:00:00'
        try:
            try:
                ex.export_table_parallel('sys_audit')
            except urllib.error.HTTPError as error:
                assert error.code == 400
            else:
                raise AssertionError('a failed full shard must abort')
        finally:
            ex._fetch_shard = original_fetch
            ex._table_available = original_available
            ex._capture_delta_fence = original_fence
        assert out_path.read_bytes() == before
        assert not list(td_path.glob('.sys_audit.full.*'))


def test_parallel_full_merge_failure_preserves_existing_snapshot():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR = td_path
        out_path = td_path / 'sys_audit.ndjson'
        _write_ndjson(out_path, [
            _row('old', sys_created_on='2026-04-29 10:00:00'),
        ])
        before = out_path.read_bytes()
        original_fetch = ex._fetch_shard
        original_available = ex._table_available
        original_fence = ex._capture_delta_fence

        def fake_fetch_shard(table, prefix):
            if prefix != 'f':
                _write_ndjson(
                    td_path / f'{table}.shard{prefix}.ndjson',
                    [_row(f'{prefix}-new', sys_created_on='2026-04-30 00:00:00')],
                )
            return 1, '2026-04-30 00:00:00'

        ex._fetch_shard = fake_fetch_shard
        ex._table_available = lambda table: True
        ex._capture_delta_fence = lambda table, query='': '2026-04-30 00:00:00'
        try:
            try:
                ex.export_table_parallel('sys_audit')
            except RuntimeError as error:
                assert 'has no output file' in str(error)
            else:
                raise AssertionError('a missing shard output must abort the merge')
        finally:
            ex._fetch_shard = original_fetch
            ex._table_available = original_available
            ex._capture_delta_fence = original_fence
        assert out_path.read_bytes() == before
        assert not list(td_path.glob('.sys_audit.full.*'))


def test_force_full_sequential_replaces_instead_of_resuming():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR = td_path
        out_path = td_path / 'incident.ndjson'
        _write_ndjson(out_path, [
            _row('old', sys_updated_on='2026-04-29 10:00:00'),
        ])
        original_get = ex.api_get_json
        original_force = ex.FORCE_FULL
        original_available = ex._table_available
        original_fence = ex._capture_delta_fence
        calls = []

        def fake_get(path, params):
            calls.append(dict(params))
            if len(calls) == 1:
                return {'result': [
                    _row('new', sys_updated_on='2026-04-30 10:00:00'),
                ]}
            return {'result': []}

        ex.api_get_json = fake_get
        ex.FORCE_FULL = True
        ex._table_available = lambda table: True
        ex._capture_delta_fence = lambda table, query='': '2026-04-30 10:00:00'
        try:
            total, watermark = ex.export_table_full('incident')
        finally:
            ex.api_get_json = original_get
            ex.FORCE_FULL = original_force
            ex._table_available = original_available
            ex._capture_delta_fence = original_fence
        assert total == 1
        assert watermark == '2026-04-30 10:00:00'
        assert [ex._extract_sid(row) for row in _read_ndjson(out_path)] == ['new']
        assert 'sys_id>old' not in calls[0]['sysparm_query']
        assert not list(td_path.glob('.incident.full.*'))


def test_force_full_sequential_failure_preserves_existing_snapshot():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR = td_path
        out_path = td_path / 'incident.ndjson'
        _write_ndjson(out_path, [
            _row('old', sys_updated_on='2026-04-29 10:00:00'),
        ])
        before = out_path.read_bytes()
        original_get = ex.api_get_json
        original_force = ex.FORCE_FULL
        original_available = ex._table_available
        original_fence = ex._capture_delta_fence
        calls = 0

        def fake_get(path, params):
            nonlocal calls
            calls += 1
            if calls == 1:
                return {'result': [
                    _row('new', sys_updated_on='2026-04-30 10:00:00'),
                ]}
            raise _http_error(400, 'Pagination not supported')

        ex.api_get_json = fake_get
        ex.FORCE_FULL = True
        ex._table_available = lambda table: True
        ex._capture_delta_fence = lambda table, query='': '2026-04-30 10:00:00'
        try:
            try:
                ex.export_table_full('incident')
            except urllib.error.HTTPError as error:
                assert error.code == 400
            else:
                raise AssertionError('a failed forced full pull must abort')
        finally:
            ex.api_get_json = original_get
            ex.FORCE_FULL = original_force
            ex._table_available = original_available
            ex._capture_delta_fence = original_fence
        assert out_path.read_bytes() == before
        partial = td_path / '.incident.full-partial.ndjson'
        assert partial.exists()
        assert [ex._extract_sid(row) for row in _read_ndjson(partial)] == ['new']


def test_sequential_missing_table_preserves_existing_snapshot():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR = td_path
        out_path = td_path / 'incident.ndjson'
        _write_ndjson(out_path, [
            _row('old', sys_updated_on='2026-04-29 10:00:00'),
        ])
        before = out_path.read_bytes()
        original_available = ex._table_available
        ex._table_available = lambda table: False
        try:
            try:
                ex.export_table_full('incident')
            except RuntimeError as error:
                assert 'preserving the existing snapshot' in str(error)
            else:
                raise AssertionError('a previously archived missing table must abort')
        finally:
            ex._table_available = original_available
        assert out_path.read_bytes() == before
        assert not list(td_path.glob('.incident.full.*'))


def test_parallel_missing_table_preserves_existing_snapshot():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR = td_path
        out_path = td_path / 'sys_audit.ndjson'
        _write_ndjson(out_path, [
            _row('old', sys_created_on='2026-04-29 10:00:00'),
        ])
        before = out_path.read_bytes()
        original_available = ex._table_available
        ex._table_available = lambda table: False
        try:
            try:
                ex.export_table_parallel('sys_audit')
            except RuntimeError as error:
                assert 'preserving the existing snapshot' in str(error)
            else:
                raise AssertionError('a previously archived missing table must abort')
        finally:
            ex._table_available = original_available
        assert out_path.read_bytes() == before


def test_new_missing_table_is_skipped_without_creating_snapshot():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR = td_path
        original_available = ex._table_available
        ex._table_available = lambda table: False
        try:
            assert ex.export_table_full('optional_table') == (None, '')
            assert ex.export_table_parallel('optional_parallel') == (None, '')
        finally:
            ex._table_available = original_available
        assert not (td_path / 'optional_table.ndjson').exists()
        assert not (td_path / 'optional_parallel.ndjson').exists()


def test_missing_optional_table_is_not_promoted_between_runs():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        old_out = ex.OUT_DIR
        old_state = ex.STATE_PATH
        original_available = ex._table_available
        original_parallel = ex.PARALLEL_TABLES
        ex.OUT_DIR = td_path
        ex.STATE_PATH = td_path / '_state.json'
        ex._table_available = lambda table: False
        ex.PARALLEL_TABLES = set()
        state = {'version': 1, 'watermarks': {}}
        try:
            assert ex.export_table('optional_table', state) == 0
            assert ex.export_table('optional_table', state) == 0
        finally:
            ex.OUT_DIR = old_out
            ex.STATE_PATH = old_state
            ex._table_available = original_available
            ex.PARALLEL_TABLES = original_parallel
        assert 'optional_table' not in state['watermarks']
        assert not (td_path / '_state.json').exists()


def test_available_empty_table_succeeds_on_consecutive_runs():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        old_out = ex.OUT_DIR
        old_state = ex.STATE_PATH
        original_get = ex.api_get_json
        original_available = ex._table_available
        original_parallel = ex.PARALLEL_TABLES
        ex.OUT_DIR = td_path
        ex.STATE_PATH = td_path / '_state.json'
        ex.api_get_json = lambda path, params: {'result': []}
        ex._table_available = lambda table: True
        ex.PARALLEL_TABLES = set()
        state = {'version': 1, 'watermarks': {}}
        try:
            assert ex.export_table('empty_table', state) == 0
            assert ex.export_table('empty_table', state) == 0
        finally:
            ex.OUT_DIR = old_out
            ex.STATE_PATH = old_state
            ex.api_get_json = original_get
            ex._table_available = original_available
            ex.PARALLEL_TABLES = original_parallel
        assert (td_path / 'empty_table.ndjson').read_bytes() == b''


def test_missing_state_with_canonical_snapshot_fails_closed():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        old_out = ex.OUT_DIR
        old_state = ex.STATE_PATH
        ex.OUT_DIR = td_path
        ex.STATE_PATH = td_path / '_state.json'
        _write_ndjson(td_path / 'incident.ndjson', [_row('old')])
        try:
            try:
                ex.read_state()
            except RuntimeError as error:
                assert 'state.json is missing' in str(error)
            else:
                raise AssertionError('missing state beside canonical data must abort')
        finally:
            ex.OUT_DIR = old_out
            ex.STATE_PATH = old_state


def test_unreadable_state_fails_closed():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        old_out = ex.OUT_DIR
        old_state = ex.STATE_PATH
        ex.OUT_DIR = td_path
        ex.STATE_PATH = td_path / '_state.json'
        ex.STATE_PATH.write_text('{broken')
        try:
            try:
                ex.read_state()
            except RuntimeError as error:
                assert 'is unreadable' in str(error)
            else:
                raise AssertionError('unreadable state must abort')
        finally:
            ex.OUT_DIR = old_out
            ex.STATE_PATH = old_state


def test_unstructured_404_is_not_treated_as_missing_table():
    original_get = ex.api_get_json
    error = urllib.error.HTTPError(
        'https://test.invalid', 404, 'Not Found', {}, io.BytesIO(b'proxy 404'),
    )
    error.historicalwow_body = 'proxy 404'
    ex.api_get_json = lambda path, params: (_ for _ in ()).throw(error)
    try:
        try:
            ex._table_available('incident')
        except urllib.error.HTTPError as caught:
            assert caught.code == 404
        else:
            raise AssertionError('an unstructured 404 must abort')
    finally:
        ex.api_get_json = original_get


def test_state_known_missing_file_still_treats_table_as_prior_archive():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        old_out = ex.OUT_DIR
        old_state = ex.STATE_PATH
        original_available = ex._table_available
        original_force = ex.FORCE_FULL
        ex.OUT_DIR = td_path
        ex.STATE_PATH = td_path / '_state.json'
        ex._table_available = lambda table: False
        ex.FORCE_FULL = False
        state = {'version': 1, 'watermarks': {
            'incident': '2026-04-30 00:00:00',
        }}
        try:
            try:
                ex.export_table('incident', state)
            except RuntimeError as error:
                assert 'previously archived table' in str(error)
            else:
                raise AssertionError('state-known unavailable table must abort')
        finally:
            ex.OUT_DIR = old_out
            ex.STATE_PATH = old_state
            ex._table_available = original_available
            ex.FORCE_FULL = original_force


def test_sequential_zero_row_visibility_collapse_preserves_snapshot():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR = td_path
        out_path = td_path / 'incident.ndjson'
        _write_ndjson(out_path, [_row(
            'old', sys_updated_on='2026-04-29 00:00:00',
        )])
        before = out_path.read_bytes()
        original_get = ex.api_get_json
        original_available = ex._table_available
        original_fence = ex._capture_delta_fence
        ex._table_available = lambda table: True
        ex.api_get_json = lambda path, params: {'result': []}
        ex._capture_delta_fence = lambda table, query='': '2026-04-30 00:00:00'
        try:
            try:
                ex.export_table_full('incident')
            except RuntimeError as error:
                assert 'returned zero rows' in str(error)
            else:
                raise AssertionError('zero-row replacement must abort')
        finally:
            ex.api_get_json = original_get
            ex._table_available = original_available
            ex._capture_delta_fence = original_fence
        assert out_path.read_bytes() == before


def test_parallel_zero_row_visibility_collapse_preserves_snapshot():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR = td_path
        out_path = td_path / 'sys_audit.ndjson'
        _write_ndjson(out_path, [_row(
            'old', sys_created_on='2026-04-29 00:00:00',
        )])
        before = out_path.read_bytes()
        original_fetch = ex._fetch_shard
        original_available = ex._table_available
        original_fence = ex._capture_delta_fence

        def empty_shard(table, prefix):
            (td_path / f'{table}.shard{prefix}.ndjson').touch()
            return 0, ''

        ex._fetch_shard = empty_shard
        ex._table_available = lambda table: True
        ex._capture_delta_fence = lambda table, query='': '2026-04-30 00:00:00'
        try:
            try:
                ex.export_table_parallel('sys_audit')
            except RuntimeError as error:
                assert 'returned zero rows' in str(error)
            else:
                raise AssertionError('zero-row parallel replacement must abort')
        finally:
            ex._fetch_shard = original_fetch
            ex._table_available = original_available
            ex._capture_delta_fence = original_fence
        assert out_path.read_bytes() == before


def _resume_api(rows):
    calls = []

    def fake_get(path, params):
        calls.append(dict(params))
        return {'result': rows if len(calls) == 1 else []}

    return calls, fake_get


def test_sequential_full_resume_reuses_original_prescan_fence():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR = td_path
        original_get = ex.api_get_json
        original_available = ex._table_available
        original_fence = ex._capture_delta_fence
        original_force = ex.FORCE_FULL
        captures = []
        first_calls = 0

        def capture(table, query=''):
            captures.append((table, query))
            return '2026-04-30 10:00:00'

        def first_get(path, params):
            nonlocal first_calls
            first_calls += 1
            if first_calls == 1:
                return {'result': [
                    _row('a', sys_updated_on='2026-04-30 10:00:00'),
                ]}
            raise _http_error(400, 'Pagination not supported')

        ex._table_available = lambda table: True
        ex._capture_delta_fence = capture
        ex.api_get_json = first_get
        ex.FORCE_FULL = False
        try:
            try:
                ex.export_table_full('incident', previously_known=False)
            except urllib.error.HTTPError:
                pass
            else:
                raise AssertionError('the interrupted first scan must fail')

            resume_calls, resume_get = _resume_api([
                # A full scan stays unbounded. Returning the original fence
                # makes this later row replayable by the next inclusive delta.
                _row('b', sys_updated_on='2026-04-30 11:00:00'),
            ])
            ex.api_get_json = resume_get
            total, watermark = ex.export_table_full(
                'incident', previously_known=False,
            )
        finally:
            ex.api_get_json = original_get
            ex._table_available = original_available
            ex._capture_delta_fence = original_fence
            ex.FORCE_FULL = original_force

        assert len(captures) == 1
        assert total == 2
        assert watermark == '2026-04-30 10:00:00'
        assert [ex._extract_sid(row) for row in _read_ndjson(
            td_path / 'incident.ndjson'
        )] == ['a', 'b']
        assert 'sys_id>a' in resume_calls[0]['sysparm_query']
        assert 'sys_updated_on<=' not in resume_calls[0]['sysparm_query']
        assert not (td_path / '.incident.full-partial.json').exists()


def test_sequential_partial_without_fence_marker_restarts_cleanly():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR = td_path
        partial = td_path / '.incident.full-partial.ndjson'
        _write_ndjson(partial, [
            _row('stale', sys_updated_on='2026-04-01 00:00:00'),
        ])
        calls, fake_get = _resume_api([
            _row('fresh', sys_updated_on='2026-04-30 00:00:00'),
        ])
        original_get = ex.api_get_json
        original_available = ex._table_available
        original_fence = ex._capture_delta_fence
        ex.api_get_json = fake_get
        ex._table_available = lambda table: True
        ex._capture_delta_fence = lambda table, query='': '2026-04-30 00:00:00'
        try:
            ex.export_table_full('incident', previously_known=False)
        finally:
            ex.api_get_json = original_get
            ex._table_available = original_available
            ex._capture_delta_fence = original_fence

        assert [ex._extract_sid(row) for row in _read_ndjson(
            td_path / 'incident.ndjson'
        )] == ['fresh']
        assert 'sys_id>stale' not in calls[0]['sysparm_query']


def test_corrupt_full_fence_marker_fails_closed():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR = td_path
        _write_ndjson(td_path / '.incident.full-partial.ndjson', [
            _row('a', sys_updated_on='2026-04-30 00:00:00'),
        ])
        (td_path / '.incident.full-partial.json').write_text('{broken')
        original_available = ex._table_available
        ex._table_available = lambda table: True
        try:
            try:
                ex.export_table_full('incident', previously_known=False)
            except RuntimeError as error:
                assert 'fence marker is unreadable' in str(error)
            else:
                raise AssertionError('a corrupt resume fence must abort')
        finally:
            ex._table_available = original_available


def test_parallel_full_resume_reuses_original_prescan_fence():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR = td_path
        base_query = ex.TABLE_FILTERS['sys_audit']
        _write_ndjson(td_path / 'sys_audit.sharda.ndjson', [
            _row('a-old', sys_created_on='2026-04-30 10:00:00'),
        ])
        ex._write_resume_fence(
            td_path / '.sys_audit.parallel-full.json', 'sys_audit',
            '2026-04-30 10:00:00', 'parallel', base_query,
        )
        original_fetch = ex._fetch_shard
        original_available = ex._table_available
        original_fence = ex._capture_delta_fence

        def fake_fetch(table, prefix):
            _write_ndjson(
                td_path / f'{table}.shard{prefix}.ndjson',
                [_row(f'{prefix}-new', sys_created_on='2026-04-30 11:00:00')],
            )
            return 1, '2026-04-30 11:00:00'

        ex._fetch_shard = fake_fetch
        ex._table_available = lambda table: True
        ex._capture_delta_fence = lambda table, query='': (_ for _ in ()).throw(
            AssertionError('a resumed parallel full must not recapture its fence')
        )
        try:
            total, watermark = ex.export_table_parallel(
                'sys_audit', previously_known=False,
            )
        finally:
            ex._fetch_shard = original_fetch
            ex._table_available = original_available
            ex._capture_delta_fence = original_fence

        assert total == 16
        assert watermark == '2026-04-30 10:00:00'
        assert not (td_path / '.sys_audit.parallel-full.json').exists()


def test_sequential_resume_repairs_valid_row_without_newline():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR = td_path
        partial = td_path / '.incident.full-partial.ndjson'
        partial.write_text(json.dumps(_row(
            'a', sys_updated_on='2026-04-29 00:00:00',
        )))
        ex._write_resume_fence(
            td_path / '.incident.full-partial.json', 'incident',
            '2026-04-30 00:00:00', 'sequential', 'sys_class_name=incident',
        )
        calls, fake_get = _resume_api([
            _row('b', sys_updated_on='2026-04-30 00:00:00'),
        ])
        original_get = ex.api_get_json
        original_available = ex._table_available
        ex.api_get_json = fake_get
        ex._table_available = lambda table: True
        try:
            ex.export_table_full('incident', previously_known=False)
        finally:
            ex.api_get_json = original_get
            ex._table_available = original_available
        rows = _read_ndjson(td_path / 'incident.ndjson')
        assert [ex._extract_sid(row) for row in rows] == ['a', 'b']
        assert 'sys_id>a' in calls[0]['sysparm_query']


def test_sequential_resume_truncates_partial_invalid_tail():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR = td_path
        partial = td_path / '.incident.full-partial.ndjson'
        partial.write_bytes(
            (json.dumps(_row('a', sys_updated_on='2026-04-29 00:00:00')) + '\n')
            .encode() + b'{"sys_id":'
        )
        ex._write_resume_fence(
            td_path / '.incident.full-partial.json', 'incident',
            '2026-04-30 00:00:00', 'sequential', 'sys_class_name=incident',
        )
        calls, fake_get = _resume_api([
            _row('b', sys_updated_on='2026-04-30 00:00:00'),
        ])
        original_get = ex.api_get_json
        original_available = ex._table_available
        ex.api_get_json = fake_get
        ex._table_available = lambda table: True
        try:
            ex.export_table_full('incident', previously_known=False)
        finally:
            ex.api_get_json = original_get
            ex._table_available = original_available
        rows = _read_ndjson(td_path / 'incident.ndjson')
        assert [ex._extract_sid(row) for row in rows] == ['a', 'b']
        assert 'sys_id>a' in calls[0]['sysparm_query']


def test_shard_resume_repairs_valid_row_without_newline():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR = td_path
        shard = td_path / 'sys_audit.sharda.ndjson'
        shard.write_text(json.dumps(_row(
            'a0', sys_created_on='2026-04-29 00:00:00',
        )))
        calls, fake_get = _resume_api([
            _row('a1', sys_created_on='2026-04-30 00:00:00'),
        ])
        original_get = ex.api_get_json
        ex.api_get_json = fake_get
        try:
            ex._fetch_shard('sys_audit', 'a')
        finally:
            ex.api_get_json = original_get
        assert [ex._extract_sid(row) for row in _read_ndjson(shard)] == ['a0', 'a1']
        assert 'sys_id>a0' in calls[0]['sysparm_query']


def test_shard_resume_truncates_partial_invalid_tail():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR = td_path
        shard = td_path / 'sys_audit.sharda.ndjson'
        shard.write_bytes(
            (json.dumps(_row('a0', sys_created_on='2026-04-29 00:00:00')) + '\n')
            .encode() + b'{"sys_id":'
        )
        calls, fake_get = _resume_api([
            _row('a1', sys_created_on='2026-04-30 00:00:00'),
        ])
        original_get = ex.api_get_json
        ex.api_get_json = fake_get
        try:
            ex._fetch_shard('sys_audit', 'a')
        finally:
            ex.api_get_json = original_get
        assert [ex._extract_sid(row) for row in _read_ndjson(shard)] == ['a0', 'a1']
        assert 'sys_id>a0' in calls[0]['sysparm_query']


def test_email_body_preservation_scans_all_rows_and_excluded_fields():
    old_out = ex.OUT_DIR
    old_skip = ex.SKIP_EMAIL_BODIES
    old_effective = ex._EFFECTIVE_SKIP_EMAIL_BODIES
    try:
        for body_field in ('body', 'body_text', 'headers'):
            with tempfile.TemporaryDirectory() as td:
                ex.OUT_DIR = Path(td)
                ex.SKIP_EMAIL_BODIES = True
                ex._EFFECTIVE_SKIP_EMAIL_BODIES = None
                _write_ndjson(ex.OUT_DIR / 'sys_email.ndjson', [
                    _row('empty', body=''),
                    _row('preserved', **{body_field: 'archived content'}),
                ])
                assert ex.fields_for('sys_email') is None, body_field
    finally:
        ex.OUT_DIR = old_out
        ex.SKIP_EMAIL_BODIES = old_skip
        ex._EFFECTIVE_SKIP_EMAIL_BODIES = old_effective


def test_force_full_discards_stale_sequential_partial():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR = td_path
        partial = td_path / '.incident.full-partial.ndjson'
        _write_ndjson(partial, [_row(
            'stale', sys_updated_on='2026-04-01 00:00:00',
        )])
        calls, fake_get = _resume_api([
            _row('fresh', sys_updated_on='2026-04-30 00:00:00'),
        ])
        original_get = ex.api_get_json
        original_available = ex._table_available
        original_force = ex.FORCE_FULL
        original_fence = ex._capture_delta_fence
        ex.api_get_json = fake_get
        ex._table_available = lambda table: True
        ex.FORCE_FULL = True
        ex._capture_delta_fence = lambda table, query='': '2026-04-30 00:00:00'
        try:
            ex.export_table_full('incident', previously_known=False)
        finally:
            ex.api_get_json = original_get
            ex._table_available = original_available
            ex.FORCE_FULL = original_force
            ex._capture_delta_fence = original_fence
        assert [ex._extract_sid(row) for row in _read_ndjson(
            td_path / 'incident.ndjson'
        )] == ['fresh']
        assert 'sys_id>stale' not in calls[0]['sysparm_query']


def test_force_full_discards_stale_parallel_shards():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR = td_path
        for prefix in '0123456789abcdef':
            _write_ndjson(
                td_path / f'sys_audit.shard{prefix}.ndjson',
                [_row(f'{prefix}-stale', sys_created_on='2026-04-01 00:00:00')],
            )
        original_fetch = ex._fetch_shard
        original_available = ex._table_available
        original_force = ex.FORCE_FULL
        original_fence = ex._capture_delta_fence

        def fresh_shard(table, prefix):
            path = td_path / f'{table}.shard{prefix}.ndjson'
            assert not path.exists(), prefix
            _write_ndjson(path, [_row(
                f'{prefix}-fresh', sys_created_on='2026-04-30 00:00:00',
            )])
            return 1, '2026-04-30 00:00:00'

        ex._fetch_shard = fresh_shard
        ex._table_available = lambda table: True
        ex.FORCE_FULL = True
        ex._capture_delta_fence = lambda table, query='': '2026-04-30 00:00:00'
        try:
            ex.export_table_parallel('sys_audit', previously_known=False)
        finally:
            ex._fetch_shard = original_fetch
            ex._table_available = original_available
            ex.FORCE_FULL = original_force
            ex._capture_delta_fence = original_fence
        assert all(
            ex._extract_sid(row).endswith('-fresh')
            for row in _read_ndjson(td_path / 'sys_audit.ndjson')
        )


def _count_lines_in_file(p):
    return sum(1 for _ in p.open())


def test_state_atomic_write():
    """write_state writes to .tmp then renames — partial writes shouldn't
    leave a half-written _state.json on disk."""
    with tempfile.TemporaryDirectory() as td:
        ex.OUT_DIR    = Path(td)
        ex.STATE_PATH = Path(td) / '_state.json'

        s = {'version': 1, 'watermarks': {'incident': '2026-04-30 12:00:00'}}
        ex.write_state(s)

        # No leftover .tmp
        assert not (Path(td) / '_state.json.tmp').exists()
        # Final file is valid JSON
        loaded = json.loads(ex.STATE_PATH.read_text())
        assert loaded['watermarks']['incident'] == '2026-04-30 12:00:00'


def test_failed_run_keeps_prior_manifest_and_exits_nonzero():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        manifest = td_path / 'manifest.json'
        manifest.write_text('{"sentinel":"prior"}')
        before = manifest.read_bytes()
        old_out = ex.OUT_DIR
        old_state = ex.STATE_PATH
        old_tables = ex.TABLES
        old_export = ex.export_table
        old_attachments = ex.export_attachment_bodies
        ex.OUT_DIR = td_path
        ex.STATE_PATH = td_path / '_state.json'
        ex.TABLES = ['incident']
        ex.export_table = lambda table, state: (_ for _ in ()).throw(
            RuntimeError('simulated page failure')
        )
        attachment_called = []
        ex.export_attachment_bodies = lambda: attachment_called.append(True)
        try:
            assert ex.main() == 1
        finally:
            ex.OUT_DIR = old_out
            ex.STATE_PATH = old_state
            ex.TABLES = old_tables
            ex.export_table = old_export
            ex.export_attachment_bodies = old_attachments
        assert manifest.read_bytes() == before
        assert attachment_called == []


def test_selective_manifest_preserves_whole_snapshot_time():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        prior_time = '2026-05-01T00:00:00Z'
        prior = {
            'label': 'prior', 'snapshot_date': '2026-05-01',
            'instance': 'test.service-now.com', 'captured_at': prior_time,
            'tables': [
                {'table': 'incident', 'rows': 1, 'source_rows': 1,
                 'watermark': 'old'},
                {'table': 'sys_audit', 'rows': 1, 'source_rows': 1,
                 'watermark': 'old'},
            ],
            'integrity': {},
        }
        (td_path / 'manifest.json').write_text(json.dumps(prior))
        old_out = ex.OUT_DIR
        old_tables = ex.TABLES
        ex.OUT_DIR = td_path
        ex.TABLES = ['incident']
        try:
            ex.write_manifest(
                {'incident': 2},
                {'watermarks': {'incident': 'new'}},
            )
        finally:
            ex.OUT_DIR = old_out
            ex.TABLES = old_tables
        result = json.loads((td_path / 'manifest.json').read_text())
        by_table = {row['table']: row for row in result['tables']}
        assert result['captured_at'] == prior_time
        assert result['snapshot_date'] == '2026-05-01'
        assert by_table['sys_audit']['captured_at'] == prior_time
        assert by_table['incident']['captured_at'] != prior_time


# ---- runner ----------------------------------------------------------------

if __name__ == '__main__':
    tests = [(name, fn) for name, fn in globals().items()
             if name.startswith('test_') and callable(fn)]
    print(f'historicalwow_export — {len(tests)} tests')
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f'  ✓ {name}')
        except AssertionError as e:
            print(f'  ✗ {name}: {e}')
            failed += 1
        except Exception as e:
            import traceback
            print(f'  ✗ {name}: unexpected {type(e).__name__}: {e}')
            traceback.print_exc()
            failed += 1
    if failed:
        print(f'\n{failed} test(s) failed')
        sys.exit(1)
    print('\nall tests passed')
