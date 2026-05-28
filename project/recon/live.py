"""Phase B — live reconciliation against the source ServiceNow instance.

Reuses historicalwow_export ('ex') for OAuth, HTTP, and the exact per-table
query filters the exporter applied, so the live side is composed identically to
how the archive was captured. The exporter module is imported lazily — and only
after confirming SN_* env is set — because it sys.exit(2)s at import time when
creds are absent. Tests inject a stub by setting ``live.ex`` directly.
"""
import http.client
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

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


_RC_TRANSIENT = (urllib.error.URLError, http.client.HTTPException,
                 TimeoutError, ssl.SSLError, ConnectionError)


def _live_readable_count(table, query):
    """ACL-respecting count from the /api/now/table endpoint via the
    X-Total-Count response header — one API call. Use this for count_parity,
    not /api/now/stats: the stats API ignores ACLs and over-counts whenever the
    OAuth export user lacks read access to some rows (i.e. it counts records
    the export could never have captured). This is apples-to-apples with the
    export. Mirrors ex.api_get_json's retry/backoff for 401/429/5xx."""
    e = get_ex()
    params = {'sysparm_query': query, 'sysparm_limit': 1, 'sysparm_fields': 'sys_id'}
    url = 'https://%s/api/now/table/%s?%s' % (
        e.INSTANCE, table, urllib.parse.urlencode(params))
    last = None
    for attempt in range(1, e.RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers={
                'Authorization': 'Bearer %s' % e.get_token(),
                'Accept': 'application/json',
            })
            with urllib.request.urlopen(req, timeout=e.TIMEOUT) as r:
                total = r.headers.get('X-Total-Count')
            return int(total) if total is not None else None
        except urllib.error.HTTPError as he:
            if he.code == 401:
                e._token['access_token'] = None
                continue
            if he.code == 429 or 500 <= he.code < 600:
                time.sleep(min(60, 2 ** attempt))
                last = he
                continue
            raise
        except _RC_TRANSIENT as exc:
            time.sleep(min(60, 2 ** attempt))
            last = exc
    raise RuntimeError('readable count failed for %s: %s' % (table, last))


def _live_readable_or_stats(table, query):
    """Try _live_readable_count (/table X-Total-Count) first; on HTTP 400/414
    fall back to _stats_count (some queries — e.g. sys_audit's very long
    tablenameIN<DISPLAYED> filter — get rejected by the /table endpoint but
    served by /stats). Returns (count, source) where source is 'table' or
    'stats_fallback' so the caller can flag the fallback in the report."""
    try:
        return _live_readable_count(table, query), 'table'
    except urllib.error.HTTPError as he:
        if he.code in (400, 414):
            return _stats_count(table, query), 'stats_fallback'
        raise


# ---- checks ----------------------------------------------------------------
def count_parity(table, manifest, state, db_count, tolerance_pct=1.0):
    """Live count as-of the snapshot watermark vs the DB count, using the same
    filter the exporter applied. The verdict-relevant counts come from the
    /api/now/table X-Total-Count header (ACL-respecting — apples-to-apples
    with what the export user can pull). /api/now/stats counts are recorded
    alongside as informational; when stats > readable, the gap is reported as
    `acl_filtered_asof` so the operator can see how many rows are inaccessible
    to the export user. db > live_asof = deletes since capture (PASS); live_now
    > db = creates since capture (PASS); db < live_asof within tolerance_pct =
    WARN export-window churn; beyond it = FAIL real loss / stale DB."""
    base = _base_filter(table)
    cutoff, src = common.snapshot_cutoff(table, manifest, state)
    res = {'verdict': PASS, 'db': db_count, 'cutoff': cutoff, 'cutoff_source': src}
    base_q = '^'.join(base) if base else ''
    asof_q = '^'.join(base + ['sys_created_on<=%s' % cutoff]) if cutoff else None

    # readable counts (verdict-relevant). /table X-Total-Count is preferred;
    # fall back to /stats on long-query rejections so we never lose the signal.
    try:
        res['live_now'], src = _live_readable_or_stats(table, base_q)
        if src == 'stats_fallback':
            res['live_now_source'] = '/stats fallback (/table rejected the query)'
    except Exception as e:                                       # noqa: BLE001
        res['verdict'] = WARN
        res['error'] = 'live readable count failed: %s' % str(e)[:140]
        return res
    asof = None
    if cutoff:
        try:
            asof, src = _live_readable_or_stats(table, asof_q)
            if src == 'stats_fallback':
                res['live_asof_source'] = '/stats fallback (/table rejected the query)'
        except Exception as e:                                   # noqa: BLE001
            res['asof_error'] = str(e)[:140]
    res['live_asof'] = asof

    # /stats counts (informational; surface ACL discrepancy when stats > readable)
    try:
        res['live_now_stats'] = _stats_count(table, base_q)
    except Exception:                                            # noqa: BLE001
        pass
    if cutoff:
        try:
            stats_asof = _stats_count(table, asof_q)
            res['live_asof_stats'] = stats_asof
            if (stats_asof is not None and asof is not None
                    and stats_asof > asof):
                res['acl_filtered_asof'] = stats_asof - asof
        except Exception:                                        # noqa: BLE001
            pass

    if asof is not None:
        shortfall = asof - db_count
        if shortfall > 0:
            rel = shortfall / asof if asof else 1.0
            if tolerance_pct > 0 and rel <= tolerance_pct / 100.0:
                # rows created during the non-instantaneous export window
                # (between a table's pull and its watermark) — expected on a
                # live instance, not loss.
                res['verdict'] = WARN
                res['short_vs_asof'] = shortfall
                res['note'] = ('short %.3f%% (<= %.3g%% tol) — export-window churn'
                               % (rel * 100, tolerance_pct))
            else:
                # any shortfall at zero tolerance, or beyond the band, is loss
                res['verdict'] = FAIL
                res['missing_vs_asof'] = shortfall
        elif db_count > asof:
            res['deletes_since'] = db_count - asof          # expected; not a failure
    if res.get('live_now') is not None and res['live_now'] > db_count:
        res['creates_since'] = res['live_now'] - db_count   # expected; not a failure
    return res


def field_set(table, archive_keys, live_keys):
    """Compare the live field inventory to the archive's. live_keys is the union
    of field names over the sampled live rows (the deep-check's ~--sample random
    rows, far more than a handful, so heterogeneous-table fields are covered);
    archive_keys is the archive's full/large-sample inventory. Any field present
    live but absent from the archive (minus intentional omissions) is a gap;
    fields only in the archive are reported as extra, not a failure."""
    e = get_ex()
    intentional = _intentional_omissions(table, e.fields_for(table))
    if not live_keys:
        return {'verdict': WARN, 'note': 'no live rows sampled', 'live_fields': 0}
    missing = sorted(k for k in live_keys
                     if k not in archive_keys and k not in intentional)
    extra = sorted(k for k in archive_keys if k not in live_keys)
    return {'verdict': FAIL if missing else PASS,
            'live_fields': len(live_keys), 'archive_fields': len(archive_keys),
            'missing_from_archive': missing[:50], 'extra_in_archive': extra[:50],
            'intentional_omissions': sorted(intentional)}


def _archive_field_keys(conn, table, db_count, scan=2000):
    """Union of archived field keys — full scan when small, else a sample. Used
    for the field-set inventory when no offline profile is available, so subclass
    fields on heterogeneous tables aren't falsely reported missing."""
    limit = None if db_count <= scan else scan
    keys = set()
    for row in common.iter_raw(conn, table, limit=limit):
        keys |= set(row.keys())
    return keys


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


def deep_check(table, arch_rows, chunk, cutoff=None, volatile_fields=None):
    """Re-fetch the sampled records from live and classify each. Returns
    (summary, live_map) so population_parity can reuse the live rows. cutoff is
    the table's snapshot watermark, used to fail in-snapshot staleness;
    volatile_fields are excluded from the same-revision corruption check."""
    if volatile_fields is None:
        volatile_fields = compare.DEFAULT_VOLATILE_FIELDS
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
            compare_keys=compare_keys, intentional_omissions=omissions,
            volatile_fields=volatile_fields))
    summary = compare.summarize_deep(results)
    summary['sampled'] = len(sys_ids)
    summary['fetched_live'] = len(live_map)
    return summary, live_map


def population_parity(arch_rows, live_map):
    """Per-field non-empty rate, live vs archive, over the SAME sampled records
    (those present on both sides). Compared like-for-like rather than against
    whole-table coverage — a subtype field that's sparse table-wide but
    populated in these sampled rows must not look like a gap. A field populated
    live but empty in the archived copy of the same records is a real export gap.
    """
    arch_by_id = {sid: raw for sid, raw in arch_rows if raw is not None}
    pairs = [(arch_by_id[sid], lrow) for sid, lrow in live_map.items()
             if sid in arch_by_id]
    n = len(pairs)
    if n == 0:
        return {'verdict': PASS, 'note': 'no comparable rows', 'gap_fields': []}

    arch_ne, live_ne = {}, {}
    for arch, lrow in pairs:
        for k, v in arch.items():
            if not common.is_empty(common.uv(v)):
                arch_ne[k] = arch_ne.get(k, 0) + 1
        for k, v in lrow.items():
            if not common.is_empty(common.uv(v)):
                live_ne[k] = live_ne.get(k, 0) + 1

    fields, gaps = {}, []
    for k in sorted(set(live_ne) | set(arch_ne)):
        lc, ac = live_ne.get(k, 0) / n, arch_ne.get(k, 0) / n
        fields[k] = {'live_rate': round(lc, 4), 'archive_rate': round(ac, 4)}
        if lc >= 0.5 and ac <= 0.001:
            fields[k]['gap'] = True
            gaps.append(k)
    return {'verdict': FAIL if gaps else PASS, 'compared_rows': n,
            'gap_fields': gaps, 'fields': fields}


# ---- per-table driver ------------------------------------------------------
def run_table(conn, table, manifest, state, opts, archive_profile=None):
    """Run every Phase B check for one table. archive_profile is the Phase A
    field_profile result when available (phase=all); otherwise population parity
    derives archive coverage from the sample."""
    db_count = common.table_count(conn, table)
    tol = getattr(opts, 'count_tolerance_pct', 1.0)
    volatile = compare.DEFAULT_VOLATILE_FIELDS | set(getattr(opts, 'ignore_fields', ()) or ())
    checks = {'count_parity': count_parity(table, manifest, state, db_count,
                                           tolerance_pct=tol)}
    cutoff, _ = common.snapshot_cutoff(table, manifest, state)

    sample_n = min(opts.sample, db_count) if db_count else 0
    sample = common.sample_rows(conn, table, sample_n) if sample_n else []
    arch_rows = [(sid, raw) for sid, raw in sample if raw is not None]

    # Deep-fetch the sampled records first; its live rows (≈--sample random rows)
    # serve as the live field inventory for the checks below — far more coverage
    # than a handful of rows, and no extra API calls.
    deep, live_map = deep_check(table, arch_rows, opts.chunk, cutoff=cutoff,
                                volatile_fields=volatile)
    checks['deep_check'] = deep

    # Archive field inventory: prefer the offline profile (a full/large-sample
    # scan) so subclass-specific fields on heterogeneous tables (cmdb_ci, task)
    # aren't falsely flagged missing. Without a profile (live-only run), scan a
    # dedicated, larger sample.
    if archive_profile and archive_profile.get('fields'):
        archive_keys = set(archive_profile['fields'].keys())
    else:
        archive_keys = _archive_field_keys(conn, table, db_count)
    live_keys = set()
    for lrow in live_map.values():
        live_keys |= set(lrow.keys())
    checks['field_set'] = field_set(table, archive_keys, live_keys)

    checks['population_parity'] = population_parity(arch_rows, live_map)
    return checks
