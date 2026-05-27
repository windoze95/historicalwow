"""Phase A — offline structural integrity.

Reads the deployed SQLite archive only; needs no credentials and never imports
historicalwow_export. Validates that the DB is internally sound and that its
indexed columns faithfully reflect the `raw` envelopes the viewer serves.

build_sqlite is imported lazily (it is side-effect-free at import) so the field
extractors can be re-applied to `raw`; tests inject synthetic extractors instead.
"""
import sys

from . import common
from .common import PASS, WARN, FAIL, worst


# ---- build_sqlite.SCHEMAS loader (lazy, side-effect-free) ------------------
def get_schemas():
    """Return build_sqlite.SCHEMAS ({table: [(col, extractor), ...]}).
    Inserts project/bin on sys.path defensively so this works regardless of the
    entry point. build_sqlite guards main() behind __main__, so import is safe.
    """
    paths = common.repo_paths()
    bin_dir = str(paths['bin'])
    if bin_dir not in sys.path:
        sys.path.insert(0, bin_dir)
    import build_sqlite
    return build_sqlite.SCHEMAS


# ---- individual checks -----------------------------------------------------
def count_agreement(table, mentry, db_count):
    """DB row count vs what the exporter recorded in manifest.json. A mismatch
    means the DB build lagged or is stale (rebuild) — an internal-consistency
    WARN. The authoritative source-loss check is Phase B count parity."""
    rows = mentry.get('rows') if mentry else None
    source = mentry.get('source_rows') if mentry else None
    verdict, note = PASS, None
    if rows is not None:
        tol = max(2, int((rows or 0) * 0.0001))
        if abs(db_count - rows) > tol:
            verdict = WARN
            note = 'DB %d vs manifest rows %d (rebuild/stale?)' % (db_count, rows)
    return {'verdict': verdict, 'db': db_count, 'manifest_rows': rows,
            'manifest_source_rows': source, 'note': note}


def sys_id_integrity(conn, table, db_count):
    """No empty/NULL sys_id. Uniqueness is guaranteed by the TEXT PRIMARY KEY;
    NDJSON-level duplicates that silently overwrote on merge surface instead as
    a DB<NDJSON delta in verify_sqlite.py."""
    empty = conn.execute(
        'SELECT COUNT(*) FROM "%s" WHERE sys_id IS NULL OR sys_id = \'\'' % table
    ).fetchone()[0]
    return {'verdict': FAIL if empty else PASS, 'rows': db_count,
            'empty_sys_id': empty}


def raw_health(conn, table, sample):
    """`raw` parses as a JSON object and carries {value, ...} envelopes."""
    n = bad = enveloped = 0
    if sample > 0:
        for (raw,) in conn.execute(
                'SELECT raw FROM "%s" ORDER BY RANDOM() LIMIT ?' % table, (sample,)):
            n += 1
            row = common.parse_raw(raw)
            if row is None:
                bad += 1
                continue
            if any(isinstance(v, dict) and 'value' in v for v in row.values()):
                enveloped += 1
    verdict = PASS
    if bad:
        verdict = FAIL
    elif n and enveloped == 0:
        # export without sysparm_display_value=all would land non-enveloped rows
        verdict = WARN
    return {'verdict': verdict, 'sampled': n, 'bad_raw': bad,
            'rows_with_envelopes': enveloped}


def field_profile(conn, table, full, profile_limit, db_count):
    """Per-field present/non-empty/coverage across the table. Full scan for
    small tables; a uniform random sample above the threshold. Flags fields that
    are present but never populated (suspicious — confirmed against live in
    Phase B step 9)."""
    limit = None if (full or db_count <= profile_limit) else profile_limit
    present, nonempty, n = {}, {}, 0
    for row in common.iter_raw(conn, table, limit=limit):
        n += 1
        for k, v in row.items():
            present[k] = present.get(k, 0) + 1
            if not common.is_empty(common.uv(v)):
                nonempty[k] = nonempty.get(k, 0) + 1
    fields, suspicious = {}, []
    for k in sorted(present):
        ne = nonempty.get(k, 0)
        fields[k] = {'present': present[k], 'nonempty': ne,
                     'coverage': round(ne / n, 4) if n else 0.0}
        if n and ne == 0:
            suspicious.append(k)
    return {'verdict': WARN if suspicious else PASS, 'scanned': n,
            'sampled': limit is not None, 'field_count': len(fields),
            'suspicious_all_empty': suspicious, 'fields': fields}


def extractor_fidelity(conn, table, schema_cols, profile_fields, sample):
    """For each indexed column, re-apply its build_sqlite extractor to `raw` and
    compare to the stored value. Two distinct signals:

      - mismatch_vs_lambda: stored column disagrees with re-applying its own
        current extractor (DB built from older/different code) -> WARN, rebuild.
      - wrong-key degenerate: stored column is essentially never populated though
        a same-named source field is well-populated in raw -> FAIL (the
        wrong-field-name -> silent-NULL bug class).

    schema_cols: list of (col, extractor_lambda) or None for raw-only tables.
    profile_fields: the field_profile `fields` map (for same-name source coverage).
    """
    if not schema_cols:
        return {'verdict': PASS, 'note': 'no indexed schema (raw-only table)',
                'columns': {}, 'degenerate_columns': []}

    col_names = [c for c, _ in schema_cols]
    select_cols = ', '.join('"%s"' % c for c in col_names)
    sql = 'SELECT %s, raw FROM "%s" ORDER BY RANDOM() LIMIT ?' % (select_cols, table)
    stored_nonempty = {c: 0 for c in col_names}
    mismatch = {c: 0 for c in col_names}
    n = 0
    for row in conn.execute(sql, (sample,)):
        raw = common.parse_raw(row['raw'])
        if raw is None:
            continue
        n += 1
        for col, fn in schema_cols:
            stored = row[col]
            try:
                expected = fn(raw)
            except Exception:
                expected = None
            if not common.is_empty(stored):
                stored_nonempty[col] += 1
            if common.norm(stored) != common.norm(expected):
                mismatch[col] += 1

    columns, degenerate, verdict = {}, [], PASS
    for col in col_names:
        cov = (stored_nonempty[col] / n) if n else 0.0
        mm = mismatch[col]
        info = {'stored_coverage': round(cov, 4), 'mismatch_vs_lambda': mm}
        src = profile_fields.get(col) if profile_fields else None
        src_cov = src['coverage'] if src else None
        if src_cov is not None:
            info['source_coverage'] = src_cov
        # FAIL: source well-populated, extracted column essentially empty.
        if n and src_cov is not None and src_cov >= 0.5 and cov <= 0.001:
            info['degenerate'] = True
            degenerate.append(col)
            verdict = worst(verdict, FAIL)
        # WARN: stored column drifts from its own current extractor.
        elif n and mm / n > 0.01:
            info['stale'] = True
            verdict = worst(verdict, WARN)
        columns[col] = info
    return {'verdict': verdict, 'sampled': n, 'columns': columns,
            'degenerate_columns': degenerate}


# ---- per-table driver ------------------------------------------------------
def run_table(conn, table, manifest_by_table, schemas, opts):
    """Run every Phase A check for one table; return the checks dict."""
    db_count = common.table_count(conn, table)
    checks = {}
    checks['count_agreement'] = count_agreement(
        table, manifest_by_table.get(table), db_count)
    checks['sys_id_integrity'] = sys_id_integrity(conn, table, db_count)
    checks['raw_health'] = raw_health(conn, table, min(opts.sample_raw, db_count))
    prof = field_profile(conn, table, opts.profile_full, opts.profile_limit, db_count)
    checks['field_profile'] = prof
    checks['extractor_fidelity'] = extractor_fidelity(
        conn, table, schemas.get(table), prof.get('fields', {}), opts.sample_extractor)
    return checks
