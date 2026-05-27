#!/usr/bin/env python3
"""Offline unit tests for the reconciliation harness — house style (plain
test_*() functions, custom runner, no pytest). Never hits live ServiceNow and
never imports historicalwow_export (a stub is injected via live.ex), so it runs
with no credentials:

    cd project
    python3 -m recon.test_recon
"""
import json
import sqlite3
import sys

from recon import common, compare, offline, live, report
from recon.common import PASS, INFO, WARN, FAIL


# ---- fixtures --------------------------------------------------------------
def env(value, display=None):
    return {'value': value, 'display_value': display if display is not None else value}


def row(sid, updated='2026-05-01 00:00:00', created='2020-01-01 00:00:00', **fields):
    r = {'sys_id': env(sid), 'sys_updated_on': env(updated),
         'sys_created_on': env(created), 'sys_created_by': env('admin'),
         'number': env('N' + sid)}
    for k, v in fields.items():
        r[k] = v if isinstance(v, dict) else env(v)
    return r


class FakeEx:
    """Stand-in for historicalwow_export. api_get_json answers sys_idIN queries
    from a canned live-row map; omitted ids simulate source deletes."""
    TABLE_FILTERS = {}

    def __init__(self, live_rows):
        self.live = {r['sys_id']['value']: r for r in live_rows}
        self.calls = []

    def class_filter(self, table):
        return ''

    def fields_for(self, table):
        return None

    def delta_field_for(self, table):
        return 'sys_updated_on'

    def field(self, r, key):
        v = r.get(key)
        return v.get('value') if isinstance(v, dict) else v

    def api_get_json(self, path, params=None):
        self.calls.append((path, params))
        q = (params or {}).get('sysparm_query', '')
        ids = []
        for part in q.split('^'):
            if part.startswith('sys_idIN'):
                ids = [x for x in part[len('sys_idIN'):].split(',') if x]
        return {'result': [self.live[i] for i in ids if i in self.live]}


def mem_db(rows_by_table, indexed=()):
    """Build an in-memory archive-style DB. rows_by_table: {table: [raw_dicts]}.
    indexed: list of (col, value_fn) extra columns to store per table."""
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    for table, rows in rows_by_table.items():
        cols = ['"sys_id" TEXT PRIMARY KEY'] + ['"%s" TEXT' % c for c, _ in indexed] + ['"raw" TEXT']
        conn.execute('CREATE TABLE "%s" (%s)' % (table, ', '.join(cols)))
        ph = ', '.join(['?'] * (2 + len(indexed)))
        for r in rows:
            vals = [r['sys_id']['value']]
            vals += [fn(r) for _, fn in indexed]
            vals.append(json.dumps(r))
            conn.execute('INSERT INTO "%s" VALUES (%s)' % (table, ph), vals)
    conn.commit()
    return conn


# ---- compare.classify_record matrix ---------------------------------------
def test_classify_deleted():
    cat, v, _ = compare.classify_record(row('a'), None)
    assert (cat, v) == ('DELETED_SINCE', INFO), (cat, v)


def test_classify_match():
    a = row('a', state='2')
    cat, v, _ = compare.classify_record(a, dict(a))
    assert (cat, v) == ('MATCH', PASS), (cat, v)


def test_classify_corruption():
    a = row('a', state='2')
    b = row('a', state='9')           # same revision, different value
    cat, v, d = compare.classify_record(a, b)
    assert (cat, v) == ('CORRUPTION', FAIL), (cat, v)
    assert any(m[0] == 'state' for m in d['value_mismatches'])


def test_classify_display_drift():
    a = row('a', mgr=env('sysid1', 'Alice'))
    b = row('a', mgr=env('sysid1', 'Alice Smith'))   # value same, label moved
    cat, v, _ = compare.classify_record(a, b)
    assert (cat, v) == ('MATCH', WARN), (cat, v)


def test_classify_missing_field():
    a = row('a')
    b = row('a', extra='something')   # live has a populated field the archive lacks
    cat, v, _ = compare.classify_record(a, b)
    assert (cat, v) == ('MISSING_FIELD', FAIL), (cat, v)


def test_classify_intentional_omission():
    a = row('a')
    b = row('a', body='big email body')
    cat, v, _ = compare.classify_record(a, b, intentional_omissions={'body'})
    assert (cat, v) == ('MATCH', PASS), (cat, v)


def test_classify_changed_since_info():
    a = row('a', updated='2026-05-01 00:00:00', state='2')
    b = row('a', updated='2026-05-20 00:00:00', state='7')   # edited after snapshot
    cat, v, _ = compare.classify_record(a, b)
    assert (cat, v) == ('CHANGED_SINCE', INFO), (cat, v)


def test_classify_changed_since_immutable_fail():
    a = row('a', updated='2026-05-01 00:00:00', created='2020-01-01 00:00:00')
    b = row('a', updated='2026-05-20 00:00:00', created='2019-01-01 00:00:00')  # created moved
    cat, v, _ = compare.classify_record(a, b)
    assert (cat, v) == ('CHANGED_SINCE', FAIL), (cat, v)


def test_classify_archive_newer():
    a = row('a', updated='2026-05-20 00:00:00')
    b = row('a', updated='2026-05-01 00:00:00')   # live older than archive
    cat, v, d = compare.classify_record(a, b)
    assert (cat, v) == ('CHANGED_SINCE', WARN), (cat, v)
    assert d.get('reason') == 'archive_newer_than_live'


def test_classify_append_only_created_axis():
    # sys_audit-style: no sys_updated_on; compare on sys_created_on.
    a = {'sys_id': env('a'), 'sys_created_on': env('2026-04-01 00:00:00'), 'newvalue': env('x')}
    b = {'sys_id': env('a'), 'sys_created_on': env('2026-04-01 00:00:00'), 'newvalue': env('x')}
    cat, v, _ = compare.classify_record(a, b, delta_field='sys_created_on')
    assert (cat, v) == ('MATCH', PASS), (cat, v)


# ---- compare.compare_fields ------------------------------------------------
def test_compare_fields_empty_not_missing():
    # a key absent in archive but empty in live is NOT a missing field
    a = row('a')
    b = row('a', blank=env(''))
    res = compare.compare_fields(a, b)
    assert 'blank' not in res['missing_in_archive'], res


def test_compare_fields_value_then_display():
    a = row('a', x=env('1', 'one'))
    b = row('a', x=env('2', 'two'))
    res = compare.compare_fields(a, b)
    assert res['value_mismatches'] and not res['display_mismatches']


# ---- offline: field profile + extractor fidelity --------------------------
def test_field_profile_flags_all_empty():
    rows = [row('a', sometimes=env('y'), always=env('')),
            row('b', sometimes=env(''), always=env('')),
            row('c', sometimes=env('z'), always=env(''))]
    conn = mem_db({'t': rows})
    prof = offline.field_profile(conn, 't', full=True, profile_limit=10, db_count=3)
    assert 'always' in prof['suspicious_all_empty'], prof['suspicious_all_empty']
    assert prof['fields']['sometimes']['present'] == 3
    assert prof['fields']['sometimes']['nonempty'] == 2
    assert abs(prof['fields']['sometimes']['coverage'] - 2 / 3) < 1e-3


def test_extractor_fidelity_degenerate_and_stale():
    # 'good' extracts active correctly; 'misread' reads a wrong key (empty though
    # source 'misread' is populated -> degenerate FAIL); 'stale' stored value
    # disagrees with re-applying its extractor (-> WARN).
    rows = [row(str(i), active=env('true'), misread=env('present%d' % i))
            for i in range(4)]
    indexed = [
        ('good', lambda r: 1 if str(common.uv(r.get('active')) or 'false').lower() == 'true' else 0),
        ('misread', lambda r: common.uv(r.get('active'))),     # store the real active...
        ('stale', lambda r: common.uv(r.get('active'))),
    ]
    conn = mem_db({'t': rows}, indexed=indexed)
    # Now corrupt the stored columns to simulate the bugs:
    conn.execute('UPDATE t SET misread = \'\'')                # wrong-key: empty
    conn.execute('UPDATE t SET stale = \'STALEVALUE\'')        # disagrees with lambda
    conn.commit()
    schema_cols = [
        ('good', lambda r: 1 if str(common.uv(r.get('active')) or 'false').lower() == 'true' else 0),
        ('misread', lambda r: common.uv(r.get('misread'))),    # extractor reads source 'misread'
        ('stale', lambda r: common.uv(r.get('active'))),
    ]
    profile_fields = {'good': {'coverage': 1.0}, 'misread': {'coverage': 1.0},
                      'stale': {'coverage': 1.0}, 'active': {'coverage': 1.0}}
    res = offline.extractor_fidelity(conn, 't', schema_cols, profile_fields, sample=10)
    assert res['verdict'] == FAIL, res
    assert 'misread' in res['degenerate_columns'], res['degenerate_columns']
    assert res['columns']['stale'].get('stale') is True, res['columns']['stale']
    assert 'good' not in res['degenerate_columns']


def test_extractor_fidelity_raw_only_table():
    conn = mem_db({'t': [row('a')]})
    res = offline.extractor_fidelity(conn, 't', None, {}, sample=10)
    assert res['verdict'] == PASS and 'no indexed schema' in res['note']


def test_sys_id_integrity_flags_empty():
    rows = [row('a'), row('b')]
    conn = mem_db({'t': rows})
    conn.execute('INSERT INTO t VALUES (?, ?)', ('', json.dumps(row(''))))
    conn.commit()
    res = offline.sys_id_integrity(conn, 't', 3)
    assert res['verdict'] == FAIL and res['empty_sys_id'] == 1, res


def test_sample_rows_returns_parsed():
    rows = [row(str(i)) for i in range(20)]
    conn = mem_db({'t': rows})
    got = common.sample_rows(conn, 't', 5)
    assert len(got) == 5
    assert all(isinstance(raw, dict) and 'sys_id' in raw for _, raw in got)


# ---- live: refetch + deep classify (stubbed ex) ----------------------------
def test_live_deep_check_categories():
    a = row('a', updated='2026-05-01 00:00:00', state='2')          # match
    b = row('b', updated='2026-05-01 00:00:00', state='2')          # corruption
    c = row('c', updated='2026-05-01 00:00:00')                     # deleted (absent live)
    d = row('d', updated='2026-05-01 00:00:00')                     # changed since
    live_rows = [
        dict(a),
        row('b', updated='2026-05-01 00:00:00', state='9'),         # value differs
        row('d', updated='2026-05-25 00:00:00'),                    # newer
    ]
    live.ex = FakeEx(live_rows)
    try:
        arch_rows = [('a', a), ('b', b), ('c', c), ('d', d)]
        summary, live_map = live.deep_check('incident', arch_rows, chunk=2)
    finally:
        live.ex = None
    assert summary['categories'] == {
        'MATCH': 1, 'CORRUPTION': 1, 'DELETED_SINCE': 1, 'CHANGED_SINCE': 1}, summary['categories']
    assert summary['verdict'] == FAIL, summary['verdict']
    assert summary['fetched_live'] == 3 and summary['sampled'] == 4
    assert len(live_map) == 3


def test_live_population_parity_gap():
    # a field populated in every live row but empty in the archive profile = gap
    live_rows = [row(str(i), wanted=env('v%d' % i)) for i in range(4)]
    arch_rows = [(str(i), row(str(i), wanted=env(''))) for i in range(4)]
    archive_profile = {'fields': {'wanted': {'coverage': 0.0}}}
    res = live.population_parity(arch_rows, live_rows, archive_profile)
    assert res['verdict'] == FAIL and 'wanted' in res['gap_fields'], res


def test_live_env_guard():
    live.ex = None
    import os
    saved = {k: os.environ.pop(k, None) for k in live.REQUIRED_ENV}
    try:
        assert live.env_ready() is False
        raised = False
        try:
            live.get_ex()
        except RuntimeError:
            raised = True
        assert raised, 'get_ex must refuse without SN_* env'
    finally:
        for k, v in saved.items():
            if v is not None:
                os.environ[k] = v


# ---- report rollup ---------------------------------------------------------
def test_report_rollup_overall_fail():
    results = {
        'good': {'offline': {'count_agreement': {'verdict': PASS}},
                 'live': {'count_parity': {'verdict': PASS}}},
        'bad': {'offline': {'extractor_fidelity': {'verdict': FAIL}}},
        'warn': {'live': {'field_set': {'verdict': WARN}}},
    }
    meta = {'phases_run': ['offline', 'live'], 'params': {'sample': 1, 'chunk': 1}}
    rep = report.build_report(meta, results)
    assert rep['overall_verdict'] == FAIL, rep['overall_verdict']
    assert rep['totals'] == {'tables': 3, 'pass': 1, 'warn': 1, 'fail': 1}, rep['totals']
    # render must not raise
    text = report.render_text(rep)
    assert 'OVERALL: FAIL' in text


def test_info_does_not_escalate():
    results = {'t': {'live': {'count_parity': {'verdict': INFO},
                              'deep_check': {'verdict': INFO}}}}
    rep = report.build_report({'phases_run': ['live'], 'params': {}}, results)
    assert rep['overall_verdict'] == PASS, rep['overall_verdict']


def test_report_includes_runner_error():
    # a table whose runner threw must FAIL the gate, not roll up as PASS/WARN
    results = {'t': {'error': {'verdict': FAIL, 'message': 'boom'}}}
    rep = report.build_report({'phases_run': ['offline'], 'params': {}}, results)
    assert rep['tables']['t']['verdict'] == FAIL, rep['tables']['t']
    assert rep['overall_verdict'] == FAIL
    assert 'boom' in report.render_text(rep)


def test_main_live_without_creds_returns_nonzero():
    # a live or all run with no SN_* must exit non-zero, never a green report
    import os
    import shutil
    import sqlite3
    import tempfile
    from recon import reconcile
    d = tempfile.mkdtemp()
    dbp = os.path.join(d, 'historicalwow.db')
    c = sqlite3.connect(dbp)
    c.execute('CREATE TABLE t (sys_id TEXT PRIMARY KEY, raw TEXT)')
    c.execute("INSERT INTO t VALUES ('a', '{}')")
    c.commit()
    c.close()
    saved = {k: os.environ.pop(k, None) for k in live.REQUIRED_ENV}
    live.ex = None
    try:
        assert reconcile.main(['--phase', 'live', '--db', dbp]) == 2
        assert reconcile.main(['--phase', 'all', '--db', dbp]) == 2
    finally:
        for k, v in saved.items():
            if v is not None:
                os.environ[k] = v
        shutil.rmtree(d, ignore_errors=True)


def test_snapshot_cutoff_prefers_captured_at():
    manifest = {'captured_at': '2026-05-01T15:09:00Z',
                'tables': [{'table': 't', 'watermark': '2026-04-01 00:00:00'}]}
    state = {'watermarks': {'t': '2026-04-01 00:00:00'}}
    cut, src = common.snapshot_cutoff('t', manifest, state)
    assert (cut, src) == ('2026-05-01 15:09:00', 'captured_at'), (cut, src)
    # fall back to the watermark (flagged approximate) only without captured_at
    cut2, src2 = common.snapshot_cutoff(
        't', {'tables': [{'table': 't', 'watermark': '2026-04-01 00:00:00'}]}, state)
    assert src2 == 'watermark_approx', src2


# ---- runner ----------------------------------------------------------------
def _run():
    tests = sorted((n, f) for n, f in globals().items()
                   if n.startswith('test_') and callable(f))
    passed = failed = 0
    for name, fn in tests:
        try:
            fn()
            print('[PASS] %s' % name)
            passed += 1
        except Exception as e:                                   # noqa: BLE001
            import traceback
            print('[FAIL] %s -> %s' % (name, e))
            traceback.print_exc()
            failed += 1
    print('\n%d passed, %d failed' % (passed, failed))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(_run())
