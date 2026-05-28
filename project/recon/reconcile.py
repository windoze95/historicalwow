"""CLI entrypoint + runner for the reconciliation harness.

    cd project
    python3 -m recon.reconcile --phase all --sample 200

Orchestrates Phase A (offline) and/or Phase B (live) per table, writes a
gitignored report under a data/ directory, prints the summary, and exits
non-zero on any FAIL (or on WARN with --strict).
"""
import argparse
import sys
import time
from pathlib import Path
from types import SimpleNamespace

from . import common, offline, live, report
from .common import FAIL, WARN


def parse_args(argv):
    ap = argparse.ArgumentParser(
        prog='recon.reconcile',
        description='Reconcile the deployed HistoricalWow archive against live '
                    'ServiceNow before shutdown.')
    ap.add_argument('--phase', choices=('offline', 'live', 'all'), default='all',
                    help='which checks to run (default: all)')
    ap.add_argument('--tables', default='',
                    help='comma-separated table subset (default: every table in the DB)')
    ap.add_argument('--sample', type=int, default=200,
                    help='records per table for the deep cross-check (default: 200)')
    ap.add_argument('--chunk', type=int, default=50,
                    help='sys_idIN batch size for live re-fetch (default: 50)')
    ap.add_argument('--profile-full', action='store_true',
                    help='full-scan every table for the field profile (default: '
                         'sample tables above --profile-limit rows)')
    ap.add_argument('--profile-limit', type=int, default=50000,
                    help='row threshold above which the field profile samples (default: 50000)')
    ap.add_argument('--sample-raw', type=int, default=500,
                    help='rows sampled for the raw parse/envelope check (default: 500)')
    ap.add_argument('--sample-extractor', type=int, default=5000,
                    help='rows sampled for the extractor-fidelity check (default: 5000)')
    ap.add_argument('--count-tolerance-pct', type=float, default=1.0,
                    help='live count shortfall within this %% is WARN (export-window '
                         'churn), beyond it FAIL (default: 1.0; use 0 for the final '
                         'frozen pre-shutdown gate)')
    ap.add_argument('--ignore-fields', default='',
                    help='comma-separated extra fields to treat as volatile (excluded '
                         'from the same-revision corruption check)')
    ap.add_argument('--db', default='',
                    help='path to the archive DB (default: project/data/historicalwow.db)')
    ap.add_argument('--out', default='',
                    help='report output dir (default: <data>/recon_<timestamp>)')
    ap.add_argument('--strict', action='store_true',
                    help='exit non-zero on WARN as well as FAIL')
    ap.add_argument('--allow-unsafe-out', action='store_true',
                    help='permit writing the report outside a data/ directory (not recommended)')
    return ap.parse_args(argv)


def resolve_tables(db_tables, requested):
    """Return (tables_to_run, requested_but_absent)."""
    if not requested:
        return list(db_tables), []
    want = [t.strip() for t in requested.split(',') if t.strip()]
    present = [t for t in want if t in db_tables]
    absent = [t for t in want if t not in db_tables]
    return present, absent


def main(argv=None):
    args = parse_args(argv)
    db_path = Path(args.db) if args.db else common.default_db_path()
    if not db_path.is_file():
        print('archive DB not found: %s' % db_path, file=sys.stderr)
        return 2
    conn = common.open_db_ro(db_path)
    data_dir = db_path.resolve().parent
    manifest = common.load_manifest(data_dir)
    state = common.load_state(data_dir)
    manifest_by_table = common.manifest_by_table(manifest)

    db_tables = common.db_table_names(conn)
    tables, requested_absent = resolve_tables(db_tables, args.tables)

    run_offline = args.phase in ('offline', 'all')
    run_live = args.phase in ('live', 'all')
    if run_live and not live.env_ready():
        # Missing creds means the DB<->live checks cannot run. Any run that
        # requested live (including the default --phase all gate) must fail
        # loudly rather than emit a green report that proves nothing about the
        # archive vs ServiceNow. Offline-only must be requested explicitly.
        print('SN_* env not set — cannot run the live phase. Source the '
              'exporter .env first (set -a; . ./.env; set +a), or pass '
              '--phase offline for an explicit offline-only check.',
              file=sys.stderr)
        return 2

    # The DB's intended scope = build_sqlite.SCHEMAS (the tables it builds).
    # Side-effect-free import; load it regardless of phase.
    schemas = offline.get_schemas()
    schema_tables = set(schemas)

    # Absent-table inventory (live-checkable): a table that SHOULD be in the DB
    # (it's in SCHEMAS) but isn't = whole-table loss -> FAIL via count_parity
    # below. DEFAULT_TABLES not in SCHEMAS are exported-but-not-built by design
    # -> reported as INFO, never FAIL. A --tables run only checks requested ones.
    absent_to_check = []
    exported_not_built = []
    if run_live:
        if args.tables:
            absent_to_check = [t for t in requested_absent if t in schema_tables]
            skip = [t for t in requested_absent if t not in schema_tables]
            if skip:
                print('requested tables outside the DB schema scope (not built by '
                      'design; skipped): %s' % ', '.join(skip), file=sys.stderr)
        else:
            absent_to_check = sorted(schema_tables - set(db_tables))
            try:
                e = live.get_ex()
                exported_not_built = sorted(set(e.DEFAULT_TABLES) - schema_tables)
            except Exception as err:                             # noqa: BLE001
                print('could not load DEFAULT_TABLES for inventory note: %s'
                      % str(err)[:140], file=sys.stderr)
    elif requested_absent:
        print('requested tables not in DB; offline-only cannot check them '
              '(skipped): %s' % ', '.join(requested_absent), file=sys.stderr)
    if not tables and not absent_to_check:
        print('no tables to reconcile', file=sys.stderr)
        return 2

    phases_run = []
    if run_offline:
        phases_run.append('offline')
    if run_live:
        phases_run.append('live')

    results = {}
    started = time.time()
    for i, t in enumerate(tables, 1):
        per = {}
        try:
            if run_offline:
                per['offline'] = offline.run_table(conn, t, manifest_by_table, schemas, args_to_opts(args))
            if run_live:
                ap_profile = per.get('offline', {}).get('field_profile')
                per['live'] = live.run_table(conn, t, manifest, state, args_to_opts(args),
                                             archive_profile=ap_profile)
        except Exception as err:                                 # noqa: BLE001
            # An unreconciled table must FAIL the gate, not merely warn — we did
            # not prove it matches source, so the default run must exit non-zero.
            per['error'] = {'verdict': FAIL, 'message': str(err)[:200]}
        results[t] = per
        print('[%d/%d] %-32s %s' % (i, len(tables), t,
              _quick_verdict(per)), file=sys.stderr)

    # Whole-table archive loss: intended tables with no DB table. Reconcile each
    # against live (db_count=0) so a missing table still holding source rows
    # FAILS the gate; an empty source table passes. Otherwise these would be
    # metadata-only and excluded from the verdict.
    for t in absent_to_check:
        cp = live.count_parity(t, manifest, state, 0,
                               tolerance_pct=args.count_tolerance_pct)
        cp['absent_from_db'] = True
        results[t] = {'live': {'count_parity': cp}}
        print('[absent] %-32s %s' % (t, cp.get('verdict')), file=sys.stderr)

    meta = {
        'schema_version': 1,
        'generated_at': common.utc_iso(),
        'instance': manifest.get('instance'),
        'snapshot_date': manifest.get('snapshot_date'),
        'captured_at': manifest.get('captured_at'),
        'phases_run': phases_run,
        'params': {'sample': args.sample, 'chunk': args.chunk,
                   'profile_full': args.profile_full,
                   'count_tolerance_pct': args.count_tolerance_pct},
        'elapsed_sec': round(time.time() - started, 1),
    }
    if absent_to_check:
        meta['schema_tables_absent_from_db'] = absent_to_check
    if exported_not_built:
        # exported to NDJSON but intentionally not built into the served DB
        # (not in build_sqlite.SCHEMAS) — informational, not a failure.
        meta['exported_but_not_built'] = exported_not_built

    # Cross-phase noise reduction before rollup.
    report.confirm_offline_all_empty_with_live(results)

    rep = report.build_report(meta, results)
    out_dir = Path(args.out) if args.out else (data_dir / ('recon_%s' % common.utc_stamp()))
    written = report.write_report(out_dir, rep, args.allow_unsafe_out)

    print(report.render_text(rep))
    print('report written: %s' % written)

    overall = rep['overall_verdict']
    if overall == FAIL or (args.strict and overall == WARN):
        return 1
    return 0


def args_to_opts(args):
    return SimpleNamespace(
        sample=args.sample, chunk=args.chunk, profile_full=args.profile_full,
        profile_limit=args.profile_limit, sample_raw=args.sample_raw,
        sample_extractor=args.sample_extractor,
        count_tolerance_pct=args.count_tolerance_pct,
        ignore_fields=[f.strip() for f in args.ignore_fields.split(',') if f.strip()])


def _quick_verdict(per):
    checks = {}
    for phase in ('offline', 'live'):
        if isinstance(per.get(phase), dict):
            checks.update(per[phase])
    if 'error' in per:
        return 'ERROR'
    from .compare import rollup_table
    return rollup_table(checks)


if __name__ == '__main__':
    sys.exit(main())
