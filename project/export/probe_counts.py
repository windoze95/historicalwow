#!/usr/bin/env python3
"""
Hits ServiceNow's stats API to count rows per table without fetching them.
Prints a table of counts and a rough ETA based on the smoke-test throughput.
Run from this directory with .env already sourced into the environment.
"""
import sys
sys.path.insert(0, '.')
import historicalwow_export as ex

RATE = 700  # rows/sec — calibrated from the cmn_location smoke test

def fmt_eta(seconds):
    if seconds <= 0:
        return '?'
    if seconds >= 3600:
        return f'{seconds/3600:.1f}h'
    if seconds >= 60:
        return f'{int(seconds // 60)}m {int(seconds % 60)}s'
    return f'{int(seconds)}s'

header = '{:<25} {:>14}    {:>10}'.format('Table', 'Rows', '~ETA')
print(header)
print('-' * len(header))

total = 0
errors = []
for table in ex.DEFAULT_TABLES:
    parts = [p for p in (ex.class_filter(table), ex.TABLE_FILTERS.get(table, '')) if p]
    params = {'sysparm_count': 'true'}
    if parts:
        params['sysparm_query'] = '^'.join(parts)
    try:
        resp = ex.api_get_json(f'/api/now/stats/{table}', params)
        count = int(resp.get('result', {}).get('stats', {}).get('count', 0))
    except Exception as e:
        count = -1
        errors.append((table, str(e)[:80]))
    eta_str = fmt_eta(count / RATE) if count >= 0 else '?'
    count_str = f'{count:,}' if count >= 0 else 'error'
    print('{:<25} {:>14}    {:>10}'.format(table, count_str, eta_str))
    if count > 0:
        total += count

print('-' * len(header))
print('{:<25} {:>14}    {:>10}'.format('TOTAL (table phase)', f'{total:,}', fmt_eta(total / RATE)))

if errors:
    print()
    for t, e in errors:
        print(f'  ! {t}: {e}')
