#!/usr/bin/env python3
"""
Self-contained tests for historicalwow_export.py — exercises the file I/O,
state, and delta-merge logic against a temp dir. The HTTP layer is stubbed.

Run: python3 test_exporter.py
"""
import json
import os
import sys
import tempfile
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
    # Bad/empty inputs
    assert ex._safe_name(None) == 'file'
    assert ex._safe_name('') == 'file'
    # Length cap
    assert len(ex._safe_name('a' * 300)) == 200


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
        ex.fetch_pages_offset = lambda table, query: iter([delta_rows])

        rows_total, watermark = ex.export_table_delta('incident', '2026-04-30 00:00:00')

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

        ex.fetch_pages_offset = lambda table, query: iter([])
        rows_total, watermark = ex.export_table_delta('incident', '2026-04-30 00:00:00')

        assert rows_total == 1
        assert watermark == '2026-04-30 00:00:00', 'watermark must not regress when no delta'
        assert out_path.read_bytes() == original_bytes, 'file should be untouched'


def test_delta_paginated_across_multiple_pages():
    """fetch_pages_offset returns a generator of pages; merge should work
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
        ex.fetch_pages_offset = lambda table, query: iter([page1, page2])

        rows_total, watermark = ex.export_table_delta('incident', '2026-04-30 00:00:00')

        assert rows_total == 2
        assert watermark == '2026-04-30 11:00:00'

        result = _read_ndjson(out_path)
        sids = [ex._extract_sid(r) for r in result]
        assert sids == ['inc1', 'inc2']
        assert ex.field(result[0], 'state') == '2'


def test_delta_with_row_lacking_sys_updated_on_doesnt_crash():
    """A delta row with no sys_updated_on still merges; watermark just doesn't
    advance from that row's contribution."""
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        ex.OUT_DIR    = td_path
        ex.STATE_PATH = td_path / '_state.json'
        out_path = td_path / 'incident.ndjson'

        _write_ndjson(out_path, [_row('inc1', sys_updated_on='2026-04-29 10:00:00')])

        # Bare row (no sys_updated_on)
        bad = {'sys_id': {'value': 'inc2', 'display_value': 'inc2'}}
        ex.fetch_pages_offset = lambda table, query: iter([[bad]])

        rows_total, watermark = ex.export_table_delta('incident', '2026-04-30 00:00:00')
        assert rows_total == 2  # inc1 + inc2
        assert watermark == '2026-04-30 00:00:00'  # unchanged: no delta row had a higher updated


def test_parallel_merge_concatenates_shards_in_order():
    """export_table_parallel runs each hex-prefix shard, then concatenates
    the per-shard NDJSON files into the final <table>.ndjson and reports
    the maximum sys_updated_on observed across all shards."""
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
        ex._fetch_shard = fake_fetch_shard
        try:
            total, watermark = ex.export_table_parallel('sys_audit')
        finally:
            ex._fetch_shard = original

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
