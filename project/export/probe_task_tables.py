#!/usr/bin/env python3
"""
Walk sys_db_object to discover every table whose ancestry traces back to `task`,
then probe row counts for each. Tells us exactly what we're missing from the
current DEFAULT_TABLES list.
"""
import sys
sys.path.insert(0, '.')
import historicalwow_export as ex

PAGE = 10000
RATE = 700  # rows/sec, calibrated from cmn_location smoke test

# --- 1. Build sys_id → name and parent_sys_id → [child_name, ...] -----------

sys_id_to_name = {}
parent_sid_to_children = {}
offset = 0
fetched = 0
while True:
    resp = ex.api_get_json('/api/now/table/sys_db_object', {
        'sysparm_limit': PAGE,
        'sysparm_offset': offset,
        'sysparm_fields': 'name,super_class,sys_id',
        'sysparm_display_value': 'all',
    })
    rows = resp.get('result', [])
    if not rows:
        break
    for r in rows:
        sid = ex.field(r, 'sys_id')
        name = ex.field(r, 'name')
        if not sid or not name:
            continue
        sys_id_to_name[sid] = name
        sc = r.get('super_class')
        parent_sid = sc.get('value') if isinstance(sc, dict) else None
        if parent_sid:
            parent_sid_to_children.setdefault(parent_sid, []).append(name)
    fetched += len(rows)
    if len(rows) < PAGE:
        break
    offset += PAGE

print(f'Walked sys_db_object: {fetched} table definitions, '
      f'{len(parent_sid_to_children)} parents with children\n')

# Find sys_id of the `task` table
name_to_sys_id = {n: s for s, n in sys_id_to_name.items()}
task_sid = name_to_sys_id.get('task')
if not task_sid:
    print('ERROR: could not find sys_db_object record for "task"')
    sys.exit(1)

# --- 2. BFS by sys_id from task --------------------------------------------------

descendants = set()
queue = [task_sid]
while queue:
    parent_sid = queue.pop()
    for child_name in parent_sid_to_children.get(parent_sid, []):
        if child_name in descendants:
            continue
        descendants.add(child_name)
        child_sid = name_to_sys_id.get(child_name)
        if child_sid:
            queue.append(child_sid)

# --- 3. Mark which are already covered -----------------------------------

current = set(ex.DEFAULT_TABLES)
new_tables = sorted(descendants - current)
already = sorted(descendants & current)

# --- 4. Count rows for each descendant -----------------------------------

def fmt_eta(seconds):
    if seconds <= 0: return '?'
    if seconds >= 3600: return f'{seconds/3600:.1f}h'
    if seconds >= 60: return f'{int(seconds // 60)}m {int(seconds % 60)}s'
    return f'{int(seconds)}s'

def count_rows(t):
    try:
        resp = ex.api_get_json(f'/api/now/stats/{t}', {'sysparm_count': 'true'})
        return int(resp.get('result', {}).get('stats', {}).get('count', 0))
    except Exception as e:
        return -1

print(f'{"Table":<30} {"Status":<14} {"Rows":>12}    {"~ETA":>10}')
print('-' * 72)

total_new = 0
for t in sorted(descendants):
    n = count_rows(t)
    status = 'already' if t in current else 'NEW'
    count_str = f'{n:,}' if n >= 0 else 'error'
    eta = fmt_eta(n / RATE) if n >= 0 else '?'
    print(f'{t:<30} {status:<14} {count_str:>12}    {eta:>10}')
    if n > 0 and t not in current:
        total_new += n

print('-' * 72)
print(f'{"NEW total":<30} {"":<14} {total_new:>12,}    '
      f'{fmt_eta(total_new / RATE):>10}')
print(f'\n{len(new_tables)} task descendant table(s) NOT currently exported:')
for t in new_tables:
    print(f'  + {t}')
