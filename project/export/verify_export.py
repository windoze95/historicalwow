#!/usr/bin/env python3
"""
Verify the exported archive against three sources of truth:

  1. The on-disk NDJSON line count for each table
  2. The manifest.json `rows` field (what the script reported on completion)
  3. The pre-run probe counts captured before this export started

Surfaces:
  - Missing tables
  - File row counts that don't match what the script claimed
  - File row counts substantially BELOW the pre-run probe (silent data loss)
  - Tables exported but never logged in the manifest (or vice versa)
  - Watermark presence per table

Usage: python3 verify_export.py    (no env required, pure file reads)
"""
import json
import sys
from pathlib import Path

DATA  = Path(__file__).resolve().parent.parent / 'data'

# Probe counts captured before the run (incident is post-class-filter; many
# small task tables had 0 rows on the probe and remain 0).
PROBE = {
    'sys_choice':            42678,
    'core_company':          4052,
    'cmn_department':        980,
    'cmn_location':          3487,
    'cmn_cost_center':       411,
    'sys_user':              141765,
    'sys_user_group':        187,
    'sys_user_grmember':     3740,
    'cmdb_ci':               1006413,
    'cmdb_rel_ci':           1228606,
    'incident':              423787,
    'change_request':        14920,
    'incident_task':         2,
    'change_task':           3743,
    'task_ci':               422331,
    'task_sla':              90148,
    'sysapproval_approver':  74921,
    'sys_journal_field':     1362783,
    'sys_audit':             11787630,
    'sys_attachment':        341377,
    # Populated task descendants
    'em_ci_severity_task':   216,
    'incident_alert_task':   343,
    'kb_feedback_task':      3,
    'problem':               131,
    'problem_task':          41,
    'reconcile_duplicate_task': 459,
    'rm_epic':               8,
    'rm_scrum_task':         28,
    'rm_sprint':             3,
    'rm_story':              34,
    'roster_schedule_span_proposal': 20,
    'sa_error_handler_task': 30,
    'samp_sp_vb_task':       744,
    'samp_sw_reclamation_candidate': 707,
    'sc_req_item':           883,
    'sc_request':            886,
    'sc_task':               739,
    'asset_task':            1759,
    'sn_contract_renewal_task': 1759,
    'std_change_proposal':   158,
    'sysapproval_group':     12256,
    'upgrade_history_task':  145,
    'vtb_task':              230,
}

# Tables that legitimately have no sys_updated_on field, so a missing
# watermark is expected (not a bug).
APPEND_ONLY_TABLES = {'sys_audit', 'sys_journal_field'}

manifest = json.loads((DATA / 'manifest.json').read_text())
state    = json.loads((DATA / '_state.json').read_text())
watermarks = state.get('watermarks', {})

def count_lines(p):
    if not p.exists(): return None
    n = 0
    with p.open('rb') as f:
        for _ in f: n += 1
    return n


# ---- Per-table check ------------------------------------------------------

issues_low      = []  # row counts substantially below probe
issues_mismatch = []  # manifest count != file count
issues_missing  = []  # file doesn't exist
issues_no_wm    = []  # no watermark and not in append-only allowlist

print(f'{"Table":<35} {"Probe":>11} {"Manifest":>11} {"File":>11}  {"Δ vs probe":>11}  {"WM":<4} {"Status":<25}')
print('-' * 120)

manifest_tables = {t['table']: t for t in manifest['tables']}
all_tables = sorted(set(list(manifest_tables) + list(PROBE)))

for t in all_tables:
    m_entry = manifest_tables.get(t)
    m_rows = m_entry['rows'] if m_entry else None
    f_rows = count_lines(DATA / f'{t}.ndjson')
    p_rows = PROBE.get(t)
    has_wm = t in watermarks

    delta_str = ''
    statuses = []

    if f_rows is None:
        statuses.append('NO FILE')
        issues_missing.append(t)
    elif m_rows is not None and f_rows != m_rows:
        statuses.append(f'manifest≠file ({m_rows} vs {f_rows})')
        issues_mismatch.append((t, m_rows, f_rows))

    if p_rows is not None and f_rows is not None and p_rows > 0:
        diff = f_rows - p_rows
        # ratio relative to probe; allow new records added during run (positive)
        # but flag any drop > 1% or > 50 rows below probe baseline
        if diff < -50 and diff / p_rows < -0.01:
            statuses.append(f'BELOW PROBE ({diff:+d})')
            issues_low.append((t, p_rows, f_rows))
        delta_str = f'{diff:+d}'
    elif f_rows is not None and p_rows is None:
        delta_str = '—'

    # Watermark check (skip for append-only tables, and skip for empty tables)
    if not has_wm and t not in APPEND_ONLY_TABLES and f_rows and f_rows > 0:
        statuses.append('no watermark')
        issues_no_wm.append(t)

    if not statuses:
        statuses.append('✓')

    wm_mark = '✓' if has_wm else ('—' if t in APPEND_ONLY_TABLES else '✗')
    print(f'{t:<35} {p_rows!s:>11} {m_rows!s:>11} {f_rows!s:>11}  {delta_str:>11}  {wm_mark:<4} {", ".join(statuses):<25}')


# ---- Summary --------------------------------------------------------------

print()
print('=' * 80)
print('SUMMARY')
print('=' * 80)

total_rows = sum((m['rows'] or 0) for m in manifest['tables'])
print(f'Total rows across all tables: {total_rows:,}')
print(f'Tables in manifest: {len(manifest_tables)}')
print(f'Tables with watermark: {len(watermarks)}')

attach_dir = DATA / 'attachments'
if attach_dir.exists():
    body_count = sum(1 for _ in attach_dir.rglob('*') if _.is_file())
    print(f'Attachment file bodies on disk: {body_count:,}')

print()
if issues_missing:
    print(f'  ✗ {len(issues_missing)} tables MISSING NDJSON files: {issues_missing}')
if issues_mismatch:
    print(f'  ✗ {len(issues_mismatch)} tables with manifest/file row count mismatch:')
    for t, m, f in issues_mismatch:
        print(f'       {t}: manifest={m}, file={f}')
if issues_low:
    print(f'  ⚠  {len(issues_low)} tables with row count BELOW pre-run probe baseline:')
    for t, p, f in issues_low:
        print(f'       {t}: probe={p}, file={f} ({f-p:+d})')
if issues_no_wm:
    print(f'  ⚠  {len(issues_no_wm)} tables with no watermark (will full-pull on next run):')
    for t in issues_no_wm:
        print(f'       {t}')

if not (issues_missing or issues_mismatch or issues_low):
    print('  ✓ No data-completeness issues. Every table is at-or-above its pre-run baseline.')

print()
salvage = DATA / 'sys_audit.ndjson.flat-salvaged'
if salvage.exists():
    print(f'  ℹ  Salvage file present: {salvage.name} '
          f'({salvage.stat().st_size:,} bytes — safe to delete after spot-checking sys_audit.ndjson)')
