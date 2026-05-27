"""Phase B — live reconciliation against the source ServiceNow instance.

Reuses historicalwow_export ('ex') for OAuth, HTTP, and the exact per-table
query filters the exporter applied, so the live side is composed identically to
how the archive was captured. The exporter module is imported lazily — and only
after confirming SN_* env is set — because it sys.exit(2)s at import time when
creds are absent. Tests inject a stub by setting ``live.ex`` directly.
"""
import os
import sys

from . import common, compare
from .common import PASS, WARN, FAIL


REQUIRED_ENV = ('SN_INSTANCE', 'SN_CLIENT_ID', 'SN_CLIENT_SECRET',
                'SN_USERNAME', 'SN_PASSWORD')

# Fields deliberately not archived for a table (so they must not be flagged as
# missing). sys_email bodies are skipped unless SN_SKIP_EMAIL_BODIES=0; the live
# re-fetch uses the same allowlist, so this is belt-and-suspenders.
_OMISSIONS = {'sys_email': frozenset({'body', 'body_text', 'headers'})}

ex = None  # set lazily by get_ex(); tests overwrite with a stub


def env_ready():
    return all(os.environ.get(k) for k in REQUIRED_ENV)


def get_ex():
    """Lazy-import historicalwow_export, after an env check so its import-time
    sys.exit(2) can never fire. Caches the module; tests pre-set ``ex``."""
    global ex
    if ex is not None:
        return ex
    if not env_ready():
        raise RuntimeError(
            'SN_* env not set — cannot run the live phase. Source the exporter '
            ".env first (set -a; . ./.env; set +a).")
    paths = common.repo_paths()
    for d in (str(paths['export']), str(paths['bin'])):
        if d not in sys.path:
            sys.path.insert(0, d)
    import historicalwow_export as _m
    ex = _m
    return ex


# ---- query helpers ---------------------------------------------------------
def _base_filter(table):
    """The exporter's per-table filter parts (class filter + table filter)."""
    e = get_ex()
    return [p for p in (e.class_filter(table), e.TABLE_FILTERS.get(table, '')) if p]


def _intentional_omissions(table, flds):
    if table in _OMISSIONS and flds:
        return _OMISSIONS[table]
    return frozenset()


def _stats_count(table, query):
    e = get_ex()
    params = {'sysparm_count': 'true'}
    if query:
        params['sysparm_query'] = query
    resp = e.api_get_json('/api/now/stats/%s' % table, params)
    if not isinstance(resp, dict):
        return None
    return int(resp.get('result', {}).get('stats', {}).get('count', 0))


# ---- checks ----------------------------------------------------------------
def count_parity(table, manifest, state, db_count):
    """Live count as-of the snapshot watermark vs the DB count, using the same
    filter the exporter applied. db < live_asof = real loss (FAIL); db >
    live_asof = source deletes since capture (reported, PASS); live_now > db =
    creates since capture (reported, PASS)."""
    base = _base_filter(table)
    cutoff, src = common.snapshot_cutoff(table, manifest, state)
    res = {'verdict': PASS, 'db': db_count, 'cutoff': cutoff, 'cutoff_source': src}

    try:
        res['live_now'] = _stats_count(table, '^'.join(base) if base else '')
    except Exception as e:                                       # noqa: BLE001
        res['verdict'] = WARN
        res['error'] = 'live count failed: %s' % str(e)[:140]
        return res

    asof = None
    if cutoff:
        try:
            asof = _stats_count(table, '^'.join(base + ['sys_created_on<=%s' % cutoff]))
        except Exception as e:                                   # noqa: BLE001
            res['asof_error'] = str(e)[:140]
    res['live_asof'] = asof

    if asof is not None:
        tol = max(2, int(asof * 0.0001))
        if db_count < asof - tol:
            res['verdict'] = FAIL
            res['missing_vs_asof'] = asof - db_count
        elif db_count > asof + tol:
            res['deletes_since'] = db_count - asof          # expected; not a failure
    if res.get('live_now') is not None and res['live_now'] > db_count:
        res['creates_since'] = res['live_now'] - db_count   # expected; not a failure
    return res


def field_set(table, archive_keys):
    """Compare the live field set to the archive's. Any live field absent from
    the archive (minus intentional omissions) is a capture gap."""
    e = get_ex()
    flds = e.fields_for(table)
    params = {'sysparm_display_value': 'all', 'sysparm_exclude_reference_link': 'true',
              'sysparm_limit': 5}
    base = _base_filter(table)
    if base:
        params['sysparm_query'] = '^'.join(base)
    if flds:
        params['sysparm_fields'] = flds
    try:
        resp = e.api_get_json('/api/now/table/%s' % table, params)
    except Exception as err:                                    # noqa: BLE001
        return {'verdict': WARN, 'error': str(err)[:140]}
    result = resp.get('result') if isinstance(resp, dict) else None
    if not isinstance(result, list) or not result:
        return {'verdict': WARN, 'note': 'no live sample rows', 'live_fields': 0}

    live_keys = set()
    for r in result:
        if isinstance(r, dict):
            live_keys |= set(r.keys())
    intentional = _intentional_omissions(table, flds)
    missing = sorted(k for k in live_keys
                     if k not in archive_keys and k not in intentional)
    extra = sorted(k for k in archive_keys if k not in live_keys)
    return {'verdict': FAIL if missing else PASS,
            'live_fields': len(live_keys), 'archive_fields': len(archive_keys),
            'missing_from_archive': missing[:50], 'extra_in_archive': extra[:50],
            'intentional_omissions': sorted(intentional)}


def refetch_live(table, sys_ids, chunk):
    """Batch re-fetch rows by sys_id with the same params the exporter used.
    Returns (sys_id -> live row, set of sys_ids whose batch succeeded). A
    sys_id that was attempted-but-absent is a genuine source delete; one whose
    batch errored is unknown (not a delete)."""
    e = get_ex()
    base = _base_filter(table)
    flds = e.fields_for(table)
    out, attempted = {}, set()
    for group in common.chunked(sys_ids, chunk):
        q = '^'.join(base + ['sys_idIN' + ','.join(group)])
        params = {'sysparm_query': q, 'sysparm_display_value': 'all',
                  'sysparm_exclude_reference_link': 'true', 'sysparm_limit': len(group)}
        if flds:
            params['sysparm_fields'] = flds
        try:
            resp = e.api_get_json('/api/now/table/%s' % table, params)
        except Exception:                                        # noqa: BLE001
            continue
        result = resp.get('result') if isinstance(resp, dict) else None
        if not isinstance(result, list):
            continue
        attempted.update(group)
        for r in result:
            if isinstance(r, dict):
                sid = e.field(r, 'sys_id')
                if sid:
                    out[sid] = r
    return out, attempted


def deep_check(table, arch_rows, chunk, cutoff=None):
    """Re-fetch the sampled records from live and classify each. Returns
    (summary, live_map) so population_parity can reuse the live rows. cutoff is
    the table's snapshot watermark, used to fail in-snapshot staleness."""
    e = get_ex()
    sys_ids = [sid for sid, _ in arch_rows]
    if not sys_ids:
        return ({'verdict': PASS, 'compared': 0, 'sampled': 0, 'fetched_live': 0,
                 'categories': {}, 'failures': []}, {})
    live_map, attempted = refetch_live(table, sys_ids, chunk)
    delta_field = e.delta_field_for(table)
    flds = e.fields_for(table)
    compare_keys = set(flds.split(',')) if flds else None
    omissions = _intentional_omissions(table, flds)

    results = []
    for sid, arch in arch_rows:
        if sid not in attempted:
            results.append(('FETCH_ERROR', WARN, {}))
            continue
        results.append(compare.classify_record(
            arch, live_map.get(sid), delta_field=delta_field, cutoff=cutoff,
            compare_keys=compare_keys, intentional_omissions=omissions))
    summary = compare.summarize_deep(results)
    summary['sampled'] = len(sys_ids)
    summary['fetched_live'] = len(live_map)
    return summary, live_map


def population_parity(arch_rows, live_rows, archive_profile):
    """Per-field non-empty rate, live vs archive, over the sampled records. A
    field populated live but ~never in the archive is a real export gap."""
    live_rows = list(live_rows)
    nlive = len(live_rows)
    if nlive == 0:
        return {'verdict': PASS, 'note': 'no live rows fetched', 'gap_fields': []}

    live_ne = {}
    for r in live_rows:
        for k, v in r.items():
            if not common.is_empty(common.uv(v)):
                live_ne[k] = live_ne.get(k, 0) + 1

    arch_cov = {}
    if archive_profile and archive_profile.get('fields'):
        for k, info in archive_profile['fields'].items():
            arch_cov[k] = info.get('coverage', 0.0)
    else:
        narch = sum(1 for _, raw in arch_rows if raw is not None) or 1
        counts = {}
        for _, raw in arch_rows:
            if raw is None:
                continue
            for k, v in raw.items():
                if not common.is_empty(common.uv(v)):
                    counts[k] = counts.get(k, 0) + 1
        arch_cov = {k: c / narch for k, c in counts.items()}

    fields, gaps = {}, []
    for k, ne in sorted(live_ne.items()):
        lc, ac = ne / nlive, arch_cov.get(k, 0.0)
        fields[k] = {'live_rate': round(lc, 4), 'archive_rate': round(ac, 4)}
        if lc >= 0.5 and ac <= 0.001:
            fields[k]['gap'] = True
            gaps.append(k)
    return {'verdict': FAIL if gaps else PASS, 'live_rows': nlive,
            'gap_fields': gaps, 'fields': fields}


# ---- per-table driver ------------------------------------------------------
def run_table(conn, table, manifest, state, opts, archive_profile=None):
    """Run every Phase B check for one table. archive_profile is the Phase A
    field_profile result when available (phase=all); otherwise population parity
    derives archive coverage from the sample."""
    db_count = common.table_count(conn, table)
    checks = {'count_parity': count_parity(table, manifest, state, db_count)}
    cutoff, _ = common.snapshot_cutoff(table, manifest, state)

    sample_n = min(opts.sample, db_count) if db_count else 0
    sample = common.sample_rows(conn, table, sample_n) if sample_n else []
    arch_rows = [(sid, raw) for sid, raw in sample if raw is not None]

    archive_keys = set()
    for _, raw in arch_rows:
        archive_keys |= set(raw.keys())
    checks['field_set'] = field_set(table, archive_keys)

    deep, live_map = deep_check(table, arch_rows, opts.chunk, cutoff=cutoff)
    checks['deep_check'] = deep
    checks['population_parity'] = population_parity(
        arch_rows, live_map.values(), archive_profile)
    return checks
