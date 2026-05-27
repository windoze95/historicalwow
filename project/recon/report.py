"""Report assembly + rendering for the reconciliation harness.

Builds a machine-readable JSON report and a human text summary, both written
under a gitignored, data/-rooted output directory. The report carries
instance-specific data (counts, field names, sys_ids) and must never be
committed — write_report refuses any path not under a `data/` directory unless
explicitly overridden.
"""
import json
from pathlib import Path

from . import compare
from .common import PASS, WARN, FAIL


def build_report(meta, results):
    """meta: run metadata dict. results: {table: {'offline': checks, 'live': checks}}.
    Returns the full report dict with per-table and overall verdicts."""
    out_tables, table_verdicts = {}, {}
    counts = {PASS: 0, WARN: 0, FAIL: 0}
    for table, phases in results.items():
        checks = {}
        for phase in ('offline', 'live'):
            if phase in phases:
                checks.update(phases[phase])
        verdict = compare.rollup_table(checks)          # INFO collapses to PASS
        table_verdicts[table] = verdict
        counts[verdict] = counts.get(verdict, 0) + 1
        entry = {'verdict': verdict}
        for phase in ('offline', 'live'):
            if phase in phases:
                entry[phase] = phases[phase]
        out_tables[table] = entry

    report = dict(meta)
    report['overall_verdict'] = compare.rollup_overall(table_verdicts)
    report['totals'] = {'tables': len(results), 'pass': counts[PASS],
                        'warn': counts[WARN], 'fail': counts[FAIL]}
    report['tables'] = out_tables
    return report


# ---- human-readable text ---------------------------------------------------
def _table_signals(entry):
    """One-line signal digest for a table (greppable, instance-light)."""
    bits = []
    off = entry.get('offline', {})
    live = entry.get('live', {})

    ca = off.get('count_agreement')
    if ca and ca.get('note'):
        bits.append('count:' + ca['note'])
    si = off.get('sys_id_integrity')
    if si and si.get('empty_sys_id'):
        bits.append('empty_sys_id=%d' % si['empty_sys_id'])
    rh = off.get('raw_health')
    if rh and rh.get('bad_raw'):
        bits.append('bad_raw=%d' % rh['bad_raw'])
    fp = off.get('field_profile')
    if fp and fp.get('suspicious_all_empty'):
        bits.append('all_empty_fields=%d' % len(fp['suspicious_all_empty']))
    ef = off.get('extractor_fidelity')
    if ef and ef.get('degenerate_columns'):
        bits.append('degenerate_cols=%s' % ','.join(ef['degenerate_columns']))

    cp = live.get('count_parity')
    if cp:
        if cp.get('error'):
            bits.append('count_err')
        if 'missing_vs_asof' in cp:
            bits.append('MISSING_VS_SOURCE=%d' % cp['missing_vs_asof'])
        if cp.get('deletes_since'):
            bits.append('del_since=%d' % cp['deletes_since'])
        if cp.get('creates_since'):
            bits.append('new_since=%d' % cp['creates_since'])
    fs = live.get('field_set')
    if fs and fs.get('missing_from_archive'):
        bits.append('MISSING_FIELDS=%s' % ','.join(fs['missing_from_archive'][:5]))
    dc = live.get('deep_check')
    if dc and dc.get('categories'):
        cats = dc['categories']
        bits.append('deep{%s}' % ' '.join('%s:%d' % (k, v) for k, v in sorted(cats.items())))
    pp = live.get('population_parity')
    if pp and pp.get('gap_fields'):
        bits.append('POP_GAP=%s' % ','.join(pp['gap_fields'][:5]))
    return '  '.join(bits)


def render_text(report):
    lines = []
    lines.append('=' * 78)
    lines.append('HistoricalWow archive reconciliation')
    lines.append('generated %s | instance %s | snapshot %s'
                 % (report.get('generated_at', '?'), report.get('instance', '?'),
                    report.get('snapshot_date', '?')))
    p = report.get('params', {})
    lines.append('phases %s | sample %s | chunk %s'
                 % (','.join(report.get('phases_run', [])), p.get('sample'), p.get('chunk')))
    absent = report.get('intended_tables_absent_from_db')
    if absent:
        lines.append('intended-but-absent tables (in DEFAULT_TABLES, no DB table): %s'
                     % ', '.join(absent))
    lines.append('-' * 78)

    tables = report.get('tables', {})
    for t in sorted(tables):
        entry = tables[t]
        lines.append('[%-4s] %-32s %s' % (entry['verdict'], t, _table_signals(entry)))

    lines.append('-' * 78)
    tot = report.get('totals', {})
    lines.append('OVERALL: %s   (tables=%s pass=%s warn=%s fail=%s)'
                 % (report.get('overall_verdict', '?'), tot.get('tables'),
                    tot.get('pass'), tot.get('warn'), tot.get('fail')))

    # Detail for non-PASS tables.
    for level in (FAIL, WARN):
        flagged = [t for t in sorted(tables) if tables[t]['verdict'] == level]
        if not flagged:
            continue
        lines.append('')
        lines.append('%s detail:' % level)
        for t in flagged:
            lines.append('  %s:' % t)
            for d in _detail_lines(tables[t]):
                lines.append('    - ' + d)
    return '\n'.join(lines) + '\n'


def _detail_lines(entry):
    """Human bullets explaining why a table is WARN/FAIL."""
    out = []
    off, live = entry.get('offline', {}), entry.get('live', {})
    ef = off.get('extractor_fidelity', {})
    for col in ef.get('degenerate_columns', []):
        out.append('extractor degenerate: column "%s" empty though source populated' % col)
    fp = off.get('field_profile', {})
    if fp.get('suspicious_all_empty'):
        out.append('always-empty fields: %s' % ', '.join(fp['suspicious_all_empty'][:15]))
    cp = live.get('count_parity', {})
    if 'missing_vs_asof' in cp:
        out.append('count: DB=%s but live had %s as-of snapshot (missing %s)'
                   % (cp.get('db'), cp.get('live_asof'), cp['missing_vs_asof']))
    if cp.get('error'):
        out.append('count parity error: %s' % cp['error'])
    fs = live.get('field_set', {})
    if fs.get('missing_from_archive'):
        out.append('fields present live but missing in archive: %s'
                   % ', '.join(fs['missing_from_archive']))
    dc = live.get('deep_check', {})
    for f in dc.get('failures', [])[:10]:
        vm = f.get('value_mismatches')
        if vm:
            cols = ', '.join('%s' % m[0] for m in vm[:6])
            out.append('%s on a record: differing fields [%s]' % (f.get('category'), cols))
        elif f.get('missing_in_archive'):
            out.append('%s: fields [%s]' % (f.get('category'), ', '.join(f['missing_in_archive'][:6])))
        else:
            out.append('%s (%s)' % (f.get('category'), f.get('reason', '')))
    pp = live.get('population_parity', {})
    if pp.get('gap_fields'):
        out.append('populated live but empty in archive: %s' % ', '.join(pp['gap_fields']))
    return out or ['(no detail captured)']


# ---- writing ---------------------------------------------------------------
def _under_data_dir(path):
    """True when path sits under a directory literally named 'data' (covers
    both project/data/ and data/, the gitignored locations)."""
    return 'data' in Path(path).resolve().parts


def write_report(out_dir, report, allow_unsafe=False):
    out = Path(out_dir).resolve()
    if not allow_unsafe and not _under_data_dir(out):
        raise SystemExit(
            'refusing to write an instance-specific report outside a data/ '
            'directory: %s\n(reports are gitignored under data/; pass '
            '--allow-unsafe-out to override)' % out)
    out.mkdir(parents=True, exist_ok=True)
    (out / 'recon_report.json').write_text(
        json.dumps(report, indent=2, default=str, ensure_ascii=False))
    (out / 'recon_summary.txt').write_text(render_text(report))
    return out
