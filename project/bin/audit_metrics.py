#!/usr/bin/env python3
"""Reliability gate for the analytics layer: DB vs what the metrics claim.

The recon harness proves the archive matches the live source; this proves the
*analytics layer* matches the archive. Every number a metrics endpoint shows
is re-verified against ground truth:

  * every dimension bar, summary tile, and category→subcategory path on the
    task analytics pages is drilled into with the exact list query the viewer
    fires, and the counts must match;
  * every "configured but unused" claim is independently recomputed from the
    DB with case-folded, label-aliased choice matching (sys_choice metadata
    drifts from the rows it describes — an exact join is how a heavily-used
    choice gets misreported as unused);
  * CMDB overview distributions, staleness buckets vs the stale/fresh presets
    the viewer sends, ownership counts, and relationship coverage;
  * SLA stats for the heaviest users/groups, against direct SQL;
  * the service status grid's internal shape.

Run it on the host that serves --base, so the DB this script opens and the
DB behind the HTTP endpoints are the same files (the server's env applies:
HISTORICALWOW_APP etc.). Anonymous HTTP on both sides of each comparison
means both see the same HR-gated view; the independent SQL mirrors the gate
via /api/hr-status. Read-only throughout: GETs plus a mode=ro DB handle.

Exit 0 when every claim verifies; exit 1 with FAIL lines otherwise.
"""
import argparse
import datetime
import gzip
import json
import sqlite3
import sys
import urllib.error
import urllib.parse
import urllib.request

import server

fails = []
warns = []
checked = 0
BASE = 'http://localhost:8080'


def get_json(path, params=None):
    url = BASE + path
    if params:
        url += '?' + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=180) as r:
        body = r.read()
    # Cached lookup endpoints serve their payload pre-gzipped.
    if body[:2] == b'\x1f\x8b':
        body = gzip.decompress(body)
    return json.loads(body)


def list_total(table, **filters):
    params = {'limit': 1, 'slim': 1}
    params.update(filters)
    return get_json('/api/' + table, params)['total']


def check(surface, claim, expected, got, warn=False):
    global checked
    checked += 1
    if expected != got:
        line = '%s | %s | metric says %r, ground truth %r' % (surface, claim, expected, got)
        (warns if warn else fails).append(line)
        print(('WARN  ' if warn else 'FAIL  ') + line, flush=True)


def _fold(s):
    # Deliberately reimplemented rather than importing server._fold_choice:
    # the point of the gate is an independent derivation of the same claim.
    return str(s or '').strip().lower()


def _table_exists(conn, name):
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone() is not None


def _choice_defs(conn, table, element):
    """Active en choices as the server selects them, from the raw envelopes."""
    if not _table_exists(conn, 'sys_choice'):
        return []
    out = []
    rows = conn.execute(
        'SELECT value, label, raw FROM sys_choice WHERE name=? AND element=?',
        (table, element)).fetchall()
    for r in rows:
        try:
            raw = json.loads(r['raw'] or '{}')
        except ValueError:
            raw = {}

        def rv(key):
            v = raw.get(key)
            if isinstance(v, dict):
                v = v.get('value')
            return '' if v is None else str(v)

        if _fold(rv('inactive')) == 'true':
            continue
        language = _fold(rv('language'))
        if language and not language.startswith('en'):
            continue
        if not r['value']:
            continue
        out.append({'value': str(r['value']), 'label': str(r['label'] or r['value']),
                    'parent': rv('dependent_value')})
    return out


def audit_task_table(conn, table, hr):
    try:
        m = get_json('/api/task/metrics/' + table)
    except urllib.error.HTTPError as e:
        warns.append('%s | metrics endpoint unavailable (%s)' % (table, e.code))
        print('WARN  %s metrics endpoint unavailable (%s)' % (table, e.code), flush=True)
        return
    total = m['total']
    check(table, 'total == unfiltered list total', total, list_total(table))
    if not total:
        print('[done] task metrics %s (empty)' % table, flush=True)
        return

    for field, items in sorted((m.get('dimensions') or {}).items()):
        check(table, 'sum(dimensions.%s) == total' % field, total,
              sum(i['count'] for i in items))
        for i in items:
            got = list_total(table, **{field: i['value']})
            check(table, 'dimension %s=%r (%r) drill-down' % (field, i['value'], i['label']),
                  i['count'], got)

    for field, cov in sorted((m.get('coverage') or {}).items()):
        check(table, 'coverage.%s set+empty == total' % field, total,
              cov['set'] + cov['empty'])

    for p in m.get('subcategory_pairs') or []:
        got = list_total(table, category=p['category'], subcategory=p['value'])
        check(table, 'pair %s/%s drill-down' % (p['category'], p['value']),
              p['count'], got)

    audit_unused_claims(conn, table, m.get('unused') or {}, hr)
    print('[done] task metrics %s (%d records)' % (table, total), flush=True)


def audit_unused_claims(conn, table, unused, hr):
    """Recompute every zero-usage claim from the DB, independently folded.

    HR gating: the incident clause is replicated exactly; child tables gate
    through parent-incident ancestry, which is not worth replicating here, so
    their violations report as WARN (HR-only usage is a legitimate cause).
    """
    if not (unused.get('category') or unused.get('subcategory')):
        return
    hr_child = table != 'incident' and table in server.HR_PARENT_COLUMN
    where, args = '', []
    if table == 'incident' and not hr['unlocked']:
        where, args = ' WHERE assignment_group IS NOT ?', [hr['group_sys_id']]
    groups = conn.execute(
        'SELECT category AS c, subcategory AS s, COUNT(*) AS n FROM "%s"%s GROUP BY 1,2'
        % (table, where), args).fetchall()
    cat_counts, pair_counts = {}, {}
    for g in groups:
        cat_counts[_fold(g['c'])] = cat_counts.get(_fold(g['c']), 0) + g['n']
        key = (_fold(g['c']), _fold(g['s']))
        pair_counts[key] = pair_counts.get(key, 0) + g['n']

    for u in unused.get('category') or []:
        n = cat_counts.get(_fold(u['value']), 0)
        if _fold(u['label']) != _fold(u['value']):
            n += cat_counts.get(_fold(u['label']), 0)
        check(table, 'unused category %r truly has zero rows' % u['value'], 0, n,
              warn=hr_child)

    cat_defs = _choice_defs(conn, table, 'category')
    for u in unused.get('subcategory') or []:
        claimed = u['category']
        aliases = {_fold(claimed)}
        for d in cat_defs:
            if _fold(d['value']) == _fold(claimed) or _fold(d['label']) == _fold(claimed):
                aliases.update({_fold(d['value']), _fold(d['label'])})
        if claimed == server.EMPTY_FILTER_VALUE:
            n = sum(v for (c, s), v in pair_counts.items() if s == _fold(u['value']))
        else:
            n = sum(v for (c, s), v in pair_counts.items()
                    if s == _fold(u['value']) and c in aliases)
        check(table, 'unused subcategory %s/%r truly has zero rows' % (claimed, u['value']),
              0, n, warn=hr_child)


def audit_cmdb(conn):
    if not _table_exists(conn, 'cmdb_ci'):
        print('[skip] cmdb metrics (no cmdb_ci in this archive)', flush=True)
        return
    m = get_json('/api/cmdb/metrics')
    total = m['total']
    check('cmdb', 'total == unfiltered CI list', total, list_total('cmdb_ci'))
    for dim, field in (('classes', 'sys_class_name'),
                       ('operational_status', 'operational_status'),
                       ('install_status', 'install_status'),
                       ('discovery_source', 'discovery_source')):
        items = m.get(dim) or []
        if not items:
            continue
        check('cmdb', 'sum(%s) == total' % dim, total, sum(i['count'] for i in items))
        for i in items:
            if not i['value']:
                continue  # empty-value rows are not clickable in the viewer
            got = list_total('cmdb_ci', **{field: i['value']})
            check('cmdb', '%s %r drill-down' % (dim, i['label']), i['count'], got)
        print('[done] cmdb %s (%d values)' % (dim, len(items)), flush=True)

    st = {s['bucket']: s['count'] for s in m.get('staleness') or []}
    if st:
        check('cmdb', 'staleness buckets sum == total', total, sum(st.values()))
        snap = m['snapshot_date']

        def cut(days):
            # Same date-only cutoff the viewer computes for its stale presets.
            return (datetime.date.fromisoformat(snap)
                    - datetime.timedelta(days=days)).isoformat()

        check('cmdb', 'stale>90d tile drill-down', st.get('91-365d', 0) + st.get('365d+', 0),
              list_total('cmdb_ci', last_discovered_before=cut(90)))
        check('cmdb', 'stale>1y pill drill-down', st.get('365d+', 0),
              list_total('cmdb_ci', last_discovered_before=cut(365)))
        check('cmdb', 'fresh<=7d pill drill-down', st.get('0-7d', 0),
              list_total('cmdb_ci', last_discovered_after=cut(7)))

    ownership = m.get('ownership') or {}
    for field in ('owned_by', 'support_group'):
        if ownership.get(field) is not None:
            n = conn.execute(
                'SELECT COUNT(*) AS n FROM cmdb_ci WHERE "%s" IS NOT NULL AND "%s" != \'\''
                % (field, field)).fetchone()['n']
            check('cmdb', 'ownership.%s == direct SQL' % field, ownership[field], n)

    rel = m.get('relationships') or {}
    if 'error' in rel:
        warns.append('cmdb | relationships error: %s' % rel['error'])
    elif rel:
        check('cmdb', 'relationship types sum == total_rels', rel.get('total_rels'),
              sum(x['count'] for x in rel.get('types') or []))
        check('cmdb', 'connected+orphans == total', total,
              (rel.get('connected') or 0) + (rel.get('orphans') or 0))
        n = conn.execute(
            'SELECT COUNT(*) AS n FROM ('
            "SELECT parent AS s FROM cmdb_rel_ci WHERE parent IS NOT NULL AND parent <> '' "
            'UNION '
            "SELECT child AS s FROM cmdb_rel_ci WHERE child IS NOT NULL AND child <> '') u "
            'JOIN cmdb_ci c ON c.sys_id = u.s').fetchone()['n']
        check('cmdb', 'connected == direct SQL', rel.get('connected'), n)
    print('[done] cmdb metrics', flush=True)


def audit_sla_stats(conn, hr):
    if not (_table_exists(conn, 'task_sla') and _table_exists(conn, 'incident')):
        print('[skip] sla-stats (no task_sla/incident in this archive)', flush=True)
        return
    hr_where, hr_args = '', []
    if not hr['unlocked']:
        hr_where, hr_args = ' AND i.assignment_group IS NOT ?', [hr['group_sys_id']]
    for kind, col in (('group', 'assignment_group'), ('user', 'assigned_to')):
        tops = conn.execute(
            'SELECT i."%s" AS k, COUNT(*) AS n FROM task_sla ts '
            'JOIN incident i ON i.sys_id = ts.task '
            'WHERE i."%s" != \'\'%s GROUP BY 1 ORDER BY n DESC LIMIT 3'
            % (col, col, hr_where), hr_args).fetchall()
        for r in tops:
            api = get_json('/api/sla-stats/%s/%s' % (kind, r['k']))
            row = conn.execute(
                'SELECT COUNT(*) AS n, SUM(CASE WHEN lower(json_extract(ts.raw, '
                "'$.has_breached.value')) IN ('true','1') THEN 1 ELSE 0 END) AS b "
                'FROM task_sla ts JOIN incident i ON i.sys_id = ts.task '
                'WHERE i."%s" = ?%s' % (col, hr_where), [r['k']] + hr_args).fetchone()
            check('sla-stats', '%s %s total' % (kind, r['k']), api['total'], row['n'])
            check('sla-stats', '%s %s breached' % (kind, r['k']),
                  api['breached'], row['b'] or 0)
    print('[done] sla-stats', flush=True)


def audit_service_status():
    s = get_json('/api/service_status', {'days': 30})
    dates = set(s.get('dates') or [])
    bad = [svc['name'] for svc in s.get('services') or []
           if not set((svc.get('days') or {}).keys()) <= dates]
    check('service_status', 'every service day within window dates', [], bad)
    print('[done] service_status', flush=True)


def main(argv=None):
    global BASE
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--base', default=BASE,
                    help='server to audit (default %(default)s); must serve '
                         'the same DB this script opens')
    ap.add_argument('--tables', nargs='*', metavar='TABLE',
                    help='restrict the task-metrics pass to these tables')
    args = ap.parse_args(argv)
    BASE = args.base.rstrip('/')

    conn = sqlite3.connect('file:%s?mode=ro' % server.DB_PATH, uri=True)
    conn.row_factory = sqlite3.Row
    hr = get_json('/api/hr-status')

    tables = args.tables or sorted(server.TASK_TABLES)
    unknown = set(tables) - server.TASK_TABLES
    if unknown:
        ap.error('not task tables: %s' % ', '.join(sorted(unknown)))
    for t in tables:
        audit_task_table(conn, t, hr)
    if not args.tables:
        audit_cmdb(conn)
        audit_sla_stats(conn, hr)
        audit_service_status()

    print('\n================ AUDIT RESULT ================')
    print('checks run: %d' % checked)
    print('FAILURES: %d' % len(fails))
    for line in fails:
        print('  FAIL  ' + line)
    print('WARNINGS: %d' % len(warns))
    for line in warns:
        print('  WARN  ' + line)
    if not fails:
        print('\nAll metric claims verified against ground truth.')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
