#!/usr/bin/env python3
"""Generate project/data/flow_inventory.ndjson — one curated + enriched record
per Flow Designer flow on the source instance.

This is a DERIVED dataset: it fuses a hand-built spreadsheet inventory (good
human narrative, but high-level) with live facts pulled from ServiceNow at
build time (ordered steps, decoded per-step configs, trigger, subflow calls,
integration endpoints, and execution-outcome aggregates). Every record links
to the already-archived ``sys_hub_flow`` record by ``sys_id``.

The output (``project/data/flow_inventory.ndjson``) is gitignored — it holds
instance-specific values. This script is generic and committed; it bakes in no
instance numbers or names.

Stdlib only. Reuses the exporter (``historicalwow_export``) for OAuth + HTTP,
imported lazily after an env check — exactly like ``recon/live.py`` — because
that module ``sys.exit(2)``s at import when the ``SN_*`` env is unset.

Usage::

    cd project/export && set -a; . ./.env; set +a; cd -
    python3 project/bin/gen_flow_inventory.py \
        --xlsx ~/Downloads/Loves_ServiceNow_Flow_Inventory.xlsx
"""
import argparse
import base64
import gzip
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent          # project/bin
PROJECT = HERE.parent                            # project
DATA = PROJECT / 'data'
REQUIRED_ENV = ('SN_INSTANCE', 'SN_CLIENT_ID', 'SN_CLIENT_SECRET',
                'SN_USERNAME', 'SN_PASSWORD')

# The data-pill separator ServiceNow embeds in label_cache labels:
# "<step-number> - <Step Name>➛<Output Name>".
PILL_SEP = '➛'

NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
_SS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'


# ---------------------------------------------------------------------------
# Exporter reuse (lazy import after env check — mirrors recon/live.py)
# ---------------------------------------------------------------------------
def get_ex():
    if not all(os.environ.get(k) for k in REQUIRED_ENV):
        sys.exit('SN_* env not set — source the exporter .env first:\n'
                 '  cd project/export && set -a; . ./.env; set +a')
    for d in (str(PROJECT / 'export'), str(HERE)):
        if d not in sys.path:
            sys.path.insert(0, d)
    import historicalwow_export as ex          # noqa: E402
    return ex


# ---- {value, display_value} envelope unwrap (rows come back display_value=all)
def uv(o):
    return o.get('value') if isinstance(o, dict) else o


def udv(o):
    if isinstance(o, dict):
        return o.get('display_value') or o.get('value')
    return o


# ---------------------------------------------------------------------------
# xlsx parsing — stdlib only (zip of XML; handles inline + shared strings)
# ---------------------------------------------------------------------------
def _col_index(ref):
    """'B7' -> 1 (zero-based column)."""
    m = re.match(r'([A-Z]+)', ref or 'A')
    col = 0
    for ch in m.group(1):
        col = col * 26 + (ord(ch) - 64)
    return col - 1


def load_workbook(path):
    """Return {sheet_name: [ [cell, ...], ... ]} preserving sheet + row order."""
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        shared = []
        if 'xl/sharedStrings.xml' in names:
            sst = ET.fromstring(z.read('xl/sharedStrings.xml'))
            for si in sst:
                shared.append(''.join(t.text or '' for t in si.iter(_SS + 't')))

        wb = ET.fromstring(z.read('xl/workbook.xml'))
        rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
        rel_target = {r.get('Id'): r.get('Target') for r in rels}
        rid_attr = ('{http://schemas.openxmlformats.org/officeDocument/'
                    '2006/relationships}id')

        out = {}
        for sh in wb.find('s:sheets', NS):
            name = sh.get('name')
            target = rel_target[sh.get(rid_attr)].lstrip('/')
            if not target.startswith('xl/'):
                target = 'xl/' + target
            out[name] = _read_sheet(z.read(target), shared)
        return out


def _read_sheet(xml_bytes, shared):
    root = ET.fromstring(xml_bytes)
    rows = []
    for row in root.iter(_SS + 'row'):
        cells, maxc = {}, -1
        for c in row:
            if c.tag != _SS + 'c':
                continue
            ci = _col_index(c.get('r'))
            t = c.get('t')
            text = ''
            if t == 'inlineStr':
                is_node = c.find('s:is', NS)
                if is_node is not None:
                    text = ''.join(n.text or '' for n in is_node.iter(_SS + 't'))
            elif t == 's':
                v = c.find('s:v', NS)
                if v is not None and v.text is not None:
                    idx = int(v.text)
                    text = shared[idx] if 0 <= idx < len(shared) else ''
            else:
                v = c.find('s:v', NS)
                if v is not None:
                    text = v.text or ''
            cells[ci] = (text or '').strip()
            maxc = max(maxc, ci)
        rows.append([cells.get(i, '') for i in range(maxc + 1)])
    return rows


_ISSUE_RE = re.compile(r'\b(BROKEN|known issue|fails?|serialization error|'
                       r'error[- ]state|deprecated|abandoned)\b', re.I)


def _known_issues(*texts):
    """Pull sentences that read like a defect/known-issue out of the curated
    prose, so the viewer can surface them as a callout."""
    hits = []
    for t in texts:
        for sentence in re.split(r'(?<=[.;])\s+', t or ''):
            if _ISSUE_RE.search(sentence):
                s = sentence.strip()
                if s and s not in hits:
                    hits.append(s)
    return ' '.join(hits)


def parse_curation(book):
    """Build {flow_name: curated_dict} from the two inventory sheets. Section
    header rows (a single populated cell) set the running `area` for sheet 1
    and a `section` grouping for sheet 2."""
    curated = {}

    def is_section(cells):
        vals = [c for c in cells if c]
        return len(vals) == 1

    # Sheet 1 — Catalog flows. Cols: item, flow, SN category, pattern, active,
    # narrative, integrations/notables. Section headers carry the functional area.
    sheet1 = next((v for k, v in book.items() if 'catalog' in k.lower()), [])
    area = ''
    for cells in sheet1[3:]:                      # skip title/intro/header
        if not any(cells):
            continue
        if is_section(cells):
            area = next(c for c in cells if c)
            continue
        if len(cells) < 6:
            continue
        item, name, cat, pattern, active, narrative = (cells + [''] * 7)[:6]
        notables = cells[6] if len(cells) > 6 else ''
        if not name or name.lower() == 'flow name':
            continue
        curated[name] = {
            'catalog_item': item, 'area': area, 'category': cat,
            'pattern': pattern, 'active': active, 'narrative': narrative,
            'notables': notables, 'known_issues': _known_issues(narrative, notables),
            'sheet': 'catalog',
        }

    # Sheet 2 — Other custom flows & subflows. Cols: type, name, area, trigger,
    # active, narrative, integrations/notables. Section headers group by theme.
    sheet2 = next((v for k, v in book.items()
                   if 'other' in k.lower() or 'subflow' in k.lower()), [])
    section = ''
    for cells in sheet2[3:]:
        if not any(cells):
            continue
        if is_section(cells):
            section = next(c for c in cells if c)
            continue
        if len(cells) < 6:
            continue
        ftype, name, area2, trigger, active, narrative = (cells + [''] * 7)[:6]
        notables = cells[6] if len(cells) > 6 else ''
        if not name or name.lower() == 'name':
            continue
        curated[name] = {
            'curated_type': ftype, 'area': area2 or section, 'category': section,
            'curated_trigger': trigger, 'active': active, 'narrative': narrative,
            'notables': notables, 'known_issues': _known_issues(narrative, notables),
            'sheet': 'other',
        }
    return curated


# ---------------------------------------------------------------------------
# Live pulls
# ---------------------------------------------------------------------------
def paginate_all(ex, table, query=''):
    """Yield every row of a table (display_value=all envelopes). Returns []
    silently if the table is absent on this instance."""
    rows = []
    try:
        for page in ex.fetch_pages_offset(table, query):
            rows.extend(page)
    except Exception as e:                                       # noqa: BLE001
        print('  warn: %s pull failed: %s' % (table, str(e)[:120]), file=sys.stderr)
    return rows


def decode_values(blob):
    """action_instance(_v2).values is base64(gzip(json)). Decode to a trimmed
    {param_name: {value, display}} map; keep it small (drop the verbose
    `parameter` metadata). Returns {} on any decode failure."""
    if not blob:
        return {}
    try:
        raw = gzip.decompress(base64.b64decode(blob)).decode('utf-8')
        items = json.loads(raw)
    except Exception:                                            # noqa: BLE001
        return {}
    out = {}
    if not isinstance(items, list):
        return {}
    for it in items:
        if not isinstance(it, dict):
            continue
        name = it.get('name') or (it.get('parameter') or {}).get('name')
        if not name:
            continue
        val = it.get('value', '')
        disp = it.get('displayValue', '')
        # A configured-but-empty input is noise; keep only set values, but keep
        # the label so the viewer can show "<param>: <value>".
        if val in ('', None) and disp in ('', None):
            continue
        entry = {'value': val}
        if disp not in ('', None) and disp != val:
            entry['display'] = disp
        out[name] = entry
    return out


def _order_key(order):
    """`order` can be '10', '10➛11', '10-11' etc. Sort by the leading int."""
    s = str(order or '0')
    m = re.match(r'\s*(\d+)', s)
    return int(m.group(1)) if m else 0


def group_actions(ex):
    """flow sys_id -> [step dicts] from both action-instance generations."""
    by_flow = defaultdict(list)
    for table in ('sys_hub_action_instance_v2', 'sys_hub_action_instance'):
        for r in paginate_all(ex, table):
            flow = uv(r.get('flow'))
            if not flow:
                continue
            by_flow[flow].append({
                'order': uv(r.get('order')) or '',
                'ui_id': uv(r.get('ui_id')) or '',
                'parent_ui_id': uv(r.get('parent_ui_id')) or '',
                'action_type': udv(r.get('action_type')) or '',
                'display_text': uv(r.get('display_text')) or '',
                'config': decode_values(uv(r.get('values'))),
                '_src': table,
            })
    for flow in by_flow:
        by_flow[flow].sort(key=lambda s: (_order_key(s['order']), s['ui_id']))
    return by_flow


def group_triggers(ex):
    """flow sys_id -> trigger dict (first trigger row; catalog flows have none).

    Two generations: the legacy ``sys_hub_trigger_instance`` exposes
    ``table``/``condition`` as columns; the v2 table keeps them inside the
    base64+gzip ``trigger_inputs`` blob (same encoding as action ``values``)."""
    by_flow = {}
    for table in ('sys_hub_trigger_instance', 'sys_hub_trigger_instance_v2'):
        for r in paginate_all(ex, table):
            flow = uv(r.get('flow'))
            if not flow or flow in by_flow:
                continue
            tbl = uv(r.get('table')) or ''
            cond = uv(r.get('condition')) or ''
            if not tbl and r.get('trigger_inputs') is not None:
                inputs = decode_values(uv(r.get('trigger_inputs')))
                tbl = uv(inputs.get('table', {})) or ''
                cond = uv(inputs.get('condition', {})) or ''
            by_flow[flow] = {
                'type': uv(r.get('trigger_type')) or udv(r.get('type')) or '',
                'table': tbl,
                'condition': cond,
            }
    return by_flow


def group_logic(ex):
    """flow sys_id -> [logic block dicts]. Best-effort; never fatal."""
    by_flow = defaultdict(list)
    for r in paginate_all(ex, 'sys_hub_flow_logic'):
        flow = uv(r.get('flow'))
        if not flow:
            continue
        by_flow[flow].append({
            'order': uv(r.get('order')) or '',
            'ui_id': uv(r.get('ui_id')) or '',
            'parent_ui_id': uv(r.get('parent_ui_id')) or '',
            'kind': udv(r.get('logic_definition')) or '',
            'display_text': uv(r.get('display_text')) or '',
        })
    for flow in by_flow:
        by_flow[flow].sort(key=lambda s: (_order_key(s['order']), s['ui_id']))
    return by_flow


def pull_stats(ex):
    """flow sys_id -> execution aggregates via grouped /stats queries
    (~3 calls total, not one-per-flow). Returns {} on failure."""
    stats = defaultdict(lambda: {'run_count': 0, 'error_count': 0,
                                 'complete_count': 0, 'first_run': '',
                                 'last_run': '', 'source_tables': []})

    def grouped(query, extra=None):
        params = {'sysparm_count': 'true', 'sysparm_group_by': 'flow'}
        if query:
            params['sysparm_query'] = query
        if extra:
            params.update(extra)
        try:
            res = ex.api_get_json('/api/now/stats/sys_flow_context', params)
            return res.get('result') or []
        except Exception as e:                                   # noqa: BLE001
            print('  warn: stats query failed (%s): %s'
                  % (query or 'all', str(e)[:100]), file=sys.stderr)
            return []

    def gid(g):
        for f in g.get('groupby_fields', []):
            if f.get('field') == 'flow':
                return f.get('value')
        return None

    # run_count + first/last run, all flows in one call
    for g in grouped('', {'sysparm_max_fields': 'sys_created_on',
                          'sysparm_min_fields': 'sys_created_on'}):
        fid = gid(g)
        if not fid:
            continue
        st = g.get('stats', {})
        stats[fid]['run_count'] = int(st.get('count', 0) or 0)
        stats[fid]['last_run'] = (st.get('max', {}) or {}).get('sys_created_on', '')
        stats[fid]['first_run'] = (st.get('min', {}) or {}).get('sys_created_on', '')
    for g in grouped('state=ERROR'):
        fid = gid(g)
        if fid:
            stats[fid]['error_count'] = int(g.get('stats', {}).get('count', 0) or 0)
    for g in grouped('state=COMPLETE'):
        fid = gid(g)
        if fid:
            stats[fid]['complete_count'] = int(g.get('stats', {}).get('count', 0) or 0)
    return stats


# ---------------------------------------------------------------------------
# label_cache -> ordered human step list
# ---------------------------------------------------------------------------
def label_cache_steps(label_cache):
    """Extract the ordered, de-duplicated human step headers
    ("1 - Get Catalog Variables", ...) from a flow's label_cache JSON."""
    if not label_cache:
        return []
    try:
        arr = json.loads(label_cache)
    except Exception:                                            # noqa: BLE001
        return []
    seen = {}
    for entry in arr if isinstance(arr, list) else []:
        label = (entry or {}).get('label', '') if isinstance(entry, dict) else ''
        head = label.split(PILL_SEP)[0].strip()
        m = re.match(r'(\d+)\s*-\s*(.+)', head)
        if m:
            seen.setdefault(int(m.group(1)), head)
    return [seen[k] for k in sorted(seen)]


def derive_endpoints(steps):
    """Best-effort integration endpoints from decoded step configs (AWX job
    templates, ansible playbooks)."""
    out = []
    for s in steps:
        cfg = s.get('config') or {}
        jt = cfg.get('job_template_id')
        if jt and uv(jt):
            out.append({'kind': 'awx_job_template', 'id': uv(jt),
                        'step': s.get('action_type', '')})
        tool = cfg.get('tool_name')
        if tool and uv(tool):
            out.append({'kind': 'ansible_playbook', 'name': uv(tool),
                        'step': s.get('action_type', '')})
    return out


def fnum(n):
    """Indexed numeric columns are stored as TEXT — emit run/error counts as
    strings so the SCHEMAS _v lambdas stay CI-legal."""
    return str(n) if n is not None else ''


# ---------------------------------------------------------------------------
# Assemble
# ---------------------------------------------------------------------------
def build_record(hdr, curated, actions, trigger, logic, stat, subflow_names):
    name = udv(hdr.get('name')) or uv(hdr.get('name')) or ''
    lc_steps = label_cache_steps(uv(hdr.get('label_cache')))
    subflows = [{'name': n} for n in lc_steps
                if n.split(' - ', 1)[-1] in subflow_names]
    endpoints = derive_endpoints(actions)

    trig = trigger
    if not trig and curated.get('curated_trigger'):
        trig = {'type': 'curated', 'table': '', 'condition': curated['curated_trigger']}
    trigger_table = (trig or {}).get('table', '')

    rec = {
        'sys_id': uv(hdr.get('sys_id')),
        'name': name,
        'internal_name': uv(hdr.get('internal_name')) or '',
        'sys_class_name': uv(hdr.get('sys_class_name')) or '',
        'flow_type': udv(hdr.get('type')) or '',
        'run_as': udv(hdr.get('run_as')) or '',
        'scope': udv(hdr.get('sys_scope')) or '',
        'status': udv(hdr.get('status')) or '',
        'description': uv(hdr.get('description')) or '',
        'created_by': uv(hdr.get('sys_created_by')) or '',
        'sys_updated_on': uv(hdr.get('sys_updated_on')) or '',
        'active': str(uv(hdr.get('active'))).lower() in ('true', '1'),
        'curated': bool(curated),
        # curation
        'catalog_item': curated.get('catalog_item', ''),
        'area': curated.get('area', ''),
        'category': curated.get('category', ''),
        'pattern': curated.get('pattern', ''),
        'narrative': curated.get('narrative', ''),
        'notables': curated.get('notables', ''),
        'known_issues': curated.get('known_issues', ''),
        # flattened indexed mirrors (TEXT)
        'trigger_table': trigger_table,
        'run_count': fnum(stat['run_count']),
        'error_count': fnum(stat['error_count']),
        'last_run': stat['last_run'],
        # live enrichment (nested — lives in raw, rendered on the record page)
        'trigger': trig,
        'steps': actions,
        'logic_blocks': logic,
        'label_cache_steps': lc_steps,
        'subflows': subflows,
        'integration_endpoints': endpoints,
        'stats': {
            'run_count': stat['run_count'], 'error_count': stat['error_count'],
            'complete_count': stat['complete_count'],
            'first_run': stat['first_run'], 'last_run': stat['last_run'],
            'source_tables': stat.get('source_tables', []),
        },
        '_enriched_at': datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S'),
    }
    return rec


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--xlsx', required=True, type=Path,
                    help='Path to the Flow Inventory spreadsheet.')
    ap.add_argument('--out', type=Path, default=DATA / 'flow_inventory.ndjson')
    ap.add_argument('--limit', type=int, default=0,
                    help='Cap the number of flows (testing only).')
    ap.add_argument('--no-stats', action='store_true',
                    help='Skip execution-stat aggregation.')
    args = ap.parse_args()

    if not args.xlsx.exists():
        sys.exit('xlsx not found: %s' % args.xlsx)

    ex = get_ex()
    print('Instance: %s' % ex.INSTANCE)
    ex.get_token()                                   # fail fast on bad creds

    print('Parsing curation from %s ...' % args.xlsx.name)
    curated_map = parse_curation(load_workbook(args.xlsx))
    print('  curated flows: %d' % len(curated_map))

    print('Pulling flow headers (sys_hub_flow) ...')
    headers = paginate_all(ex, 'sys_hub_flow')
    print('  flows: %d' % len(headers))
    subflow_names = {udv(h.get('name')) or uv(h.get('name'))
                     for h in headers
                     if (udv(h.get('type')) or '').lower() == 'subflow'}

    print('Pulling action instances ...')
    actions_by_flow = group_actions(ex)
    print('Pulling triggers ...')
    triggers_by_flow = group_triggers(ex)
    print('Pulling flow logic ...')
    logic_by_flow = group_logic(ex)
    stats_by_flow = {} if args.no_stats else pull_stats(ex)
    if not args.no_stats:
        print('  flows with executions: %d' % len(stats_by_flow))

    empty_stat = {'run_count': 0, 'error_count': 0, 'complete_count': 0,
                  'first_run': '', 'last_run': '', 'source_tables': []}

    args.out.parent.mkdir(parents=True, exist_ok=True)
    n, matched, skipped = 0, 0, 0
    with args.out.open('w', encoding='utf-8') as f:
        for hdr in headers:
            sid = uv(hdr.get('sys_id'))
            if not sid:
                skipped += 1
                continue
            name = udv(hdr.get('name')) or uv(hdr.get('name')) or ''
            curated = curated_map.get(name, {})
            if curated:
                matched += 1
            rec = build_record(
                hdr, curated,
                actions_by_flow.get(sid, []),
                triggers_by_flow.get(sid),
                logic_by_flow.get(sid, []),
                dict(stats_by_flow.get(sid, empty_stat)),
                subflow_names,
            )
            f.write(json.dumps(rec, ensure_ascii=False, separators=(',', ':')) + '\n')
            n += 1
            if args.limit and n >= args.limit:
                break

    print('\nWrote %s' % args.out)
    print('  records: %d   curated-matched: %d/%d   skipped(no sys_id): %d'
          % (n, matched, len(curated_map), skipped))
    unmatched = sorted(set(curated_map) - {udv(h.get('name')) or uv(h.get('name'))
                                           for h in headers})
    if unmatched:
        print('  curated names with no live flow (expected: summary rows): %s'
              % ', '.join(repr(u)[:50] for u in unmatched[:6]))


if __name__ == '__main__':
    main()
