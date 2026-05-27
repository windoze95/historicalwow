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
    if requested_absent:
        print('requested tables not in DB (skipped): %s'
              % ', '.join(requested_absent), file=sys.stderr)
    if not tables:
        print('no tables to reconcile', file=sys.stderr)
        return 2

    run_offline = args.phase in ('offline', 'all')
    run_live = args.phase in ('live', 'all')
    if run_live and not live.env_ready():
        print('SN_* env not set — skipping live phase (source the exporter .env '
              'to enable). Running offline only.', file=sys.stderr)
        run_live = False

    phases_run = []
    if run_offline:
        phases_run.append('offline')
    if run_live:
        phases_run.append('live')

    schemas = offline.get_schemas() if run_offline else {}

    # DEFAULT_TABLES we intended to archive but that have no DB table at all.
    intended_absent = []
    if run_live:
        try:
            e = live.get_ex()
            intended_absent = sorted(t for t in e.DEFAULT_TABLES if t not in set(db_tables))
        except Exception as err:                                 # noqa: BLE001
            print('could not load DEFAULT_TABLES for inventory check: %s'
                  % str(err)[:140], file=sys.stderr)

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
            per['error'] = {'verdict': WARN, 'message': str(err)[:200]}
        results[t] = per
        print('[%d/%d] %-32s %s' % (i, len(tables), t,
              _quick_verdict(per)), file=sys.stderr)

    meta = {
        'schema_version': 1,
        'generated_at': common.utc_iso(),
        'instance': manifest.get('instance'),
        'snapshot_date': manifest.get('snapshot_date'),
        'captured_at': manifest.get('captured_at'),
        'phases_run': phases_run,
        'params': {'sample': args.sample, 'chunk': args.chunk,
                   'profile_full': args.profile_full},
        'elapsed_sec': round(time.time() - started, 1),
    }
    if intended_absent:
        meta['intended_tables_absent_from_db'] = intended_absent

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
        sample_extractor=args.sample_extractor)


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
