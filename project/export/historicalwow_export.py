#!/usr/bin/env python3
"""
HistoricalWow ServiceNow exporter.

First run: full pull of every table into ../data/<table>.ndjson, then attachment
file bodies LAST so a Ctrl+C in the body phase still leaves a complete archive
of every other table.

Subsequent runs: incremental. Tracks a `sys_updated_on` high-water mark per
table in ../data/_state.json; subsequent runs query `sys_updated_on>=watermark`,
merge results into the existing NDJSON in place (by `sys_id`), advance the
watermark. Attachments are naturally incremental — body files already on disk
are skipped.

Auth: OAuth2 password grant. Configure via environment variables:
  SN_INSTANCE        e.g. "yourcompany.service-now.com"
  SN_CLIENT_ID       OAuth application client_id
  SN_CLIENT_SECRET   OAuth application client_secret
  SN_USERNAME        service account user
  SN_PASSWORD        service account password

Optional:
  SN_PAGE_SIZE       rows per page (default 5000)
  SN_RETRIES         retry attempts on transient failure (default 5)
  SN_TIMEOUT         per-request timeout, seconds (default 120)
  SN_TABLES          comma-separated subset (default: all known tables)
  SN_SKIP_ATTACHMENTS  set to "1" to skip attachment file bodies entirely
  SN_FULL              set to "1" to ignore watermarks and force full re-export
  SN_MANIFEST_LABEL    label written into manifest.json (default: "export")

To force a fresh full re-pull of one table: delete its
  ../data/<table>.ndjson  and  the entry under "watermarks" in ../data/_state.json
or set SN_FULL=1 to redo everything.

Stdlib only — no pip dependencies. Requires Python 3.8+.
"""

import http.client
import json
import logging
import os
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


# ---- Config ----------------------------------------------------------------

INSTANCE      = os.environ.get('SN_INSTANCE', '').strip().rstrip('/')
CLIENT_ID     = os.environ.get('SN_CLIENT_ID', '').strip()
CLIENT_SECRET = os.environ.get('SN_CLIENT_SECRET', '').strip()
USERNAME      = os.environ.get('SN_USERNAME', '').strip()
PASSWORD      = os.environ.get('SN_PASSWORD', '').strip()
PAGE_SIZE     = int(os.environ.get('SN_PAGE_SIZE', '5000'))
RETRIES       = int(os.environ.get('SN_RETRIES', '5'))
TIMEOUT       = int(os.environ.get('SN_TIMEOUT', '120'))
SKIP_ATTACH   = os.environ.get('SN_SKIP_ATTACHMENTS', '').strip() in ('1', 'true', 'yes')
FORCE_FULL    = os.environ.get('SN_FULL', '').strip() in ('1', 'true', 'yes')
PARALLEL_WORKERS = int(os.environ.get('SN_PARALLEL_WORKERS', '8'))

# Tables to pull in parallel (hex-prefix sharding) instead of single-cursor.
# Applies to both full pulls AND deltas. The delta path benefits whenever a
# table churns frequently in ServiceNow (cmdb_ci sees ~hundreds of thousands
# of auto-discovery rewrites in 3 days, sys_audit grows by millions per
# month, etc.). Override via env: SN_PARALLEL_TABLES=foo,bar
_env_par = os.environ.get('SN_PARALLEL_TABLES', '').strip()
PARALLEL_TABLES = (
    set(t.strip() for t in _env_par.split(',') if t.strip())
    if _env_par else {
        'sys_audit',
        'sys_journal_field',
        'cmdb_ci',
        'cmdb_rel_ci',
        'sys_attachment',
        # Asset tables — typically tens-to-hundreds-of-thousands of rows
        # for hardware in a mid-size company, so worth sharded fetches.
        # ASSET_TABLES is defined later in the module; inline the names
        # here to keep the constant self-contained.
        'alm_asset', 'alm_hardware', 'alm_software_license', 'alm_license',
        'alm_consumable', 'alm_facility', 'alm_stockroom',
        # Software inventory — cmdb_software_instance is 300k+ rows.
        'cmdb_software_instance', 'cmdb_ci_spkg',
    }
)

if INSTANCE.startswith('https://'): INSTANCE = INSTANCE[8:]
if INSTANCE.startswith('http://'):  INSTANCE = INSTANCE[7:]

if not all([INSTANCE, CLIENT_ID, CLIENT_SECRET, USERNAME, PASSWORD]):
    print(
        'Missing env vars. Set SN_INSTANCE, SN_CLIENT_ID, SN_CLIENT_SECRET, '
        'SN_USERNAME, SN_PASSWORD before running.',
        file=sys.stderr,
    )
    sys.exit(2)

OUT_DIR    = Path(__file__).resolve().parent.parent / 'data'
ATTACH_DIR = OUT_DIR / 'attachments'
STATE_PATH = OUT_DIR / '_state.json'
OUT_DIR.mkdir(parents=True, exist_ok=True)


# ---- Tables in dependency order. Attachments LAST. -------------------------

# All concrete descendants of the `task` parent class on this instance.
# Discovered via probe_task_tables.py (BFS over sys_db_object). Tables in
# this list are queried with `sys_class_name=<table>` to return ONLY
# direct-class rows — without that, querying a parent (incident,
# change_request, etc.) also returns rows from descendants and we'd
# double-pull them when the descendant is exported separately.
# Re-run probe_task_tables.py if the instance gains new task tables.
TASK_TABLES = [
    'alm_transfer_order_line_subtask',
    'alm_transfer_order_line_task',
    'asset_reclamation_request',
    'asset_task',
    'business_app_request',
    'cert_follow_on_task',
    'cert_task',
    'change_phase',
    'change_request',
    'change_request_imac',
    'change_task',
    'chat_queue_entry',
    'cmdb_ci_exception',
    'cmdb_data_management_task',
    'cmdb_multisource_recomp_task',
    'comm_task',
    'em_ci_severity_task',
    'em_remediation_task',
    'gsw_task',
    'help_guidance_task',
    'incident',
    'incident_alert_task',
    'incident_task',
    'kb_feedback_task',
    'kb_knowledge_base_request',
    'kb_submission',
    'orphan_ci_remediation',
    'planned_task',
    'problem',
    'problem_task',
    'reclassification_task',
    'recommended_field_remediation',
    'reconcile_duplicate_task',
    'release_phase',
    'release_task',
    'required_field_remediation',
    'rm_defect',
    'rm_doc',
    'rm_enhancement',
    'rm_epic',
    'rm_feature',
    'rm_release',
    'rm_release_scrum',
    'rm_release_sdlc',
    'rm_scrum_task',
    'rm_sprint',
    'rm_story',
    'rm_task',
    'rm_test',
    'roster_schedule_span_proposal',
    'sa_error_handler_task',
    'sam_saas_playbook_task',
    'samp_asset_reclaim_task',
    'samp_sp_vb_task',
    'samp_success_activity',
    'samp_sw_eol_request',
    'samp_sw_eol_task',
    'samp_sw_reclamation_candidate',
    'sc_req_item',
    'sc_request',
    'sc_task',
    'scan_task',
    'service_process_task',
    'service_task',
    'sn_cmdb_int_util_ip_address_management_task',
    'sn_contract_renewal_task',
    'sn_deploy_pipeline_deployment_request',
    'sn_itam_common_asset_onboarding_task',
    'sn_itam_common_loaner_asset_order',
    'sn_itam_ztr_fulfillment_req',
    'sn_sforce_v2_spoke_case',
    'stale_ci_remediation',
    'statemgmt_renew_lease_task',
    'std_change_proposal',
    'success_activity',
    'sys_report_access_request',
    'sysapproval_group',
    'ticket',
    'u_scheduled_task_run',
    'upgrade_history_task',
    'vtb_task',
]
TASK_TABLES_SET = set(TASK_TABLES)

# Asset records (alm_* family). Pulled with `sys_class_name=<table>` so
# each subtype lands in its own NDJSON file even though they all live
# in the alm_asset parent class server-side. alm_asset itself catches
# anything not slotted into a more specific subtype.
ASSET_TABLES = [
    'alm_asset',
    'alm_hardware',
    'alm_software_license',
    'alm_license',
    'alm_consumable',
    'alm_facility',
    'alm_stockroom',
]

# Software inventory tables (Discovery / SAM-light). These aren't asset
# records per se but are useful "what software is in our environment"
# data that would otherwise be lost when the source instance shuts down.
SOFTWARE_TABLES = [
    'cmdb_ci_spkg',           # software package definitions (Tableau Desktop, etc.)
    'cmdb_software_instance', # installed-software-per-CI mapping
]
ASSET_TABLES_SET = set(ASSET_TABLES)
CLASS_FILTERED_SET = TASK_TABLES_SET | ASSET_TABLES_SET

DEFAULT_TABLES = [
    # Reference (small, used to resolve cross-links)
    'sys_choice',
    'core_company',
    'cmn_department',
    'cmn_location',
    'cmn_cost_center',
    # Users + groups
    'sys_user',
    'sys_user_group',
    'sys_user_grmember',
    # CMDB
    'cmdb_ci',
    'cmdb_rel_ci',
    # All task descendants (each pulled with sys_class_name=<self> filter)
    *TASK_TABLES,
    # Task relationships
    'task_ci',
    'task_sla',
    'sysapproval_approver',
    # Catalog: definitions + per-RITM variable values. The viewer joins
    # sc_item_option_mtom → sc_item_option → item_option_new to render the
    # form fields a user typed when submitting an RITM.
    'sc_cat_item',
    'item_option_new',
    'sc_item_option',
    'sc_item_option_mtom',
    'question',
    'question_choice',
    # Catalog admin metadata — the related lists shown on a sc_cat_item
    # form (Variable Sets, Catalog UI Policies, Catalog Client Scripts,
    # Available For, Not Available For, Catalogs, Categories). Without
    # these the viewer's catalog item record can only show variables.
    'sc_catalog',
    'sc_category',
    'catalog_ui_policy',
    'catalog_ui_policy_action',
    'catalog_script_client',
    'user_criteria',
    'sc_cat_item_user_criteria_mtom',
    'sc_cat_item_user_criteria_no_mtom',
    # The "Variable Set" table is `item_option_new_set` on this instance
    # (the OOTB API name `io_set` returns HTTP 400). The m2m link table
    # `io_set_item` joins it to sc_cat_item.
    'item_option_new_set',
    'io_set_item',
    # Topics — definitions only. The cat_item↔topic m2m table varies by
    # plugin (Employee Center / Now Assist taxonomy) and isn't present on
    # this instance, so the "Assigned Topics" tab stays empty until that
    # link table is identified per-instance.
    'topic',
    # Asset records (alm_* family).
    *ASSET_TABLES,
    # Software inventory (Discovery / SAM-light).
    *SOFTWARE_TABLES,
    # Server-side logic — business rules, client scripts, script includes,
    # scheduled scripts, UI policies, data policies. The viewer's per-table
    # inspector uses these to answer "what fires when a record on table X
    # is read/written?" — invaluable after the source instance is gone and
    # the only artifact left is the archive.
    'sys_script',
    'sys_script_client',
    'sys_script_include',
    'sysauto_script',
    'sys_ui_policy',
    'sys_ui_policy_action',
    'sys_data_policy2',
    'sys_data_policy_rule',
    # Activity (large)
    'sys_journal_field',
    'sys_audit',
    # Attachment metadata (file bodies handled separately, LAST)
    'sys_attachment',
]

env_tables = os.environ.get('SN_TABLES', '').strip()
TABLES = [t.strip() for t in env_tables.split(',') if t.strip()] if env_tables else DEFAULT_TABLES

# Per-table page-size override. Wide-row tables (rich-text fields, lots of
# reference fields × display_value=all = huge response payloads) need smaller
# pages to stay under ServiceNow's response byte cap. Without this, requests
# come back either as a short page (silent data loss) or with corrupt JSON
# at the truncation point.
TABLE_PAGE_SIZE = {
    'incident':            1000,
    'change_request':      1000,
    'incident_alert_task':  500,
    'sys_journal_field':   2000,
    'sys_audit':           2000,
    'sysapproval_group':   1000,  # wide rows, byte-capped at ~3.8k in early runs
}

# Append-only tables don't populate sys_updated_on (records are inserted, never
# updated). Use sys_created_on as the incremental cursor for these instead.
DELTA_FIELD = {
    'sys_audit':         'sys_created_on',
    'sys_journal_field': 'sys_created_on',
}

def delta_field_for(table):
    return DELTA_FIELD.get(table, 'sys_updated_on')

def page_size_for(table):
    return TABLE_PAGE_SIZE.get(table, PAGE_SIZE)


# Per-table query filter ANDed onto every fetch (full + delta). Trims out
# audit/journal/attachment entries attached to tables the viewer doesn't
# render — sys_user changes, cmdb_ci updates, every other system table.
# Without this, sys_audit alone is tens of millions of irrelevant rows.
DISPLAYED_TABLES = ','.join(TASK_TABLES + ASSET_TABLES + SOFTWARE_TABLES)

TABLE_FILTERS = {
    'sys_audit':         f'tablenameIN{DISPLAYED_TABLES}',
    'sys_journal_field': f'nameIN{DISPLAYED_TABLES}',
    'sys_attachment':    f'table_nameIN{DISPLAYED_TABLES}',
}


def class_filter(table):
    """For class-hierarchy tables (task, asset), return
    `sys_class_name=<table>` so we don't pull rows from descendant classes
    (which get exported on their own pass). Returns empty string for
    tables where inheritance behavior is desired (cmdb_ci should return
    all subtypes; sys_user has no inheritance)."""
    return f'sys_class_name={table}' if table in CLASS_FILTERED_SET else ''


# ---- Logging ---------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)-7s %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger('historicalwow')


# ---- OAuth -----------------------------------------------------------------

_token = {'access_token': None, 'expires_at': 0.0}
_token_lock = threading.Lock()


def get_token():
    now = time.time()
    # Fast path: token still valid with comfortable headroom.
    if _token['access_token'] and _token['expires_at'] > now + 300:
        return _token['access_token']

    # Slow path: take the lock, double-check, refresh.
    # (Without the double-check, multiple parallel workers expiring in
    # lockstep would stampede the OAuth endpoint.)
    with _token_lock:
        now = time.time()
        if _token['access_token'] and _token['expires_at'] > now + 300:
            return _token['access_token']

        body = urllib.parse.urlencode({
            'grant_type': 'password',
            'client_id': CLIENT_ID,
            'client_secret': CLIENT_SECRET,
            'username': USERNAME,
            'password': PASSWORD,
        }).encode('utf-8')
        req = urllib.request.Request(
            f'https://{INSTANCE}/oauth_token.do',
            data=body,
            headers={'Content-Type': 'application/x-www-form-urlencoded',
                     'Accept': 'application/json'},
        )
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                payload = json.loads(r.read())
        except urllib.error.HTTPError as e:
            err_body = e.read().decode('utf-8', errors='replace')
            log.error('OAuth token request failed: HTTP %s — %s', e.code, err_body[:500])
            raise
        _token['access_token'] = payload['access_token']
        _token['expires_at'] = now + int(payload.get('expires_in', 1800))
        log.info('OAuth token acquired (expires in %ss)', payload.get('expires_in', '?'))
        return _token['access_token']


# ---- HTTP helpers ----------------------------------------------------------

_TRANSIENT = (urllib.error.URLError, http.client.HTTPException, TimeoutError, ssl.SSLError, ConnectionError, json.JSONDecodeError)


def _backoff(attempt):
    return min(60, 2 ** attempt)


def api_get_json(path, params=None):
    qs = ('?' + urllib.parse.urlencode(params)) if params else ''
    url = f'https://{INSTANCE}{path}{qs}'
    last_err = None
    for attempt in range(1, RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers={
                'Authorization': f'Bearer {get_token()}',
                'Accept': 'application/json',
            })
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 401:
                _token['access_token'] = None
                continue
            if e.code == 429 or 500 <= e.code < 600:
                wait = _backoff(attempt)
                log.warning('HTTP %s on %s — backing off %ss (attempt %d/%d)',
                            e.code, path, wait, attempt, RETRIES)
                time.sleep(wait)
                last_err = e
                continue
            err_body = e.read().decode('utf-8', errors='replace')
            log.error('HTTP %s on %s — %s', e.code, path, err_body[:500])
            raise
        except _TRANSIENT as e:
            wait = _backoff(attempt)
            log.warning('Network error on %s: %s — backing off %ss (attempt %d/%d)',
                        path, e, wait, attempt, RETRIES)
            time.sleep(wait)
            last_err = e
    raise RuntimeError(f'GET {path} failed after {RETRIES} retries: {last_err}')


def api_get_binary(path):
    url = f'https://{INSTANCE}{path}'
    last_err = None
    # Binary fetches retry less aggressively than table fetches: most 500s
    # on attachment file bodies are persistent (broken/quarantined source
    # blobs), and 5 retries × exponential backoff would tie up a parallel
    # worker for ~30-60s per dead attachment. The slow rate already
    # observed in production was almost entirely retry-blocking, not
    # actual download throughput. Override via SN_BINARY_RETRIES.
    retries = int(os.environ.get('SN_BINARY_RETRIES', '2'))
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers={
                'Authorization': f'Bearer {get_token()}',
            })
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return r.read(), r.headers.get('Content-Type', '')
        except urllib.error.HTTPError as e:
            if e.code == 401:
                _token['access_token'] = None
                continue
            if e.code == 429 or 500 <= e.code < 600:
                # On the last attempt, don't bother sleeping just to fail.
                if attempt < retries:
                    time.sleep(_backoff(attempt))
                last_err = e
                continue
            raise
        except _TRANSIENT as e:
            if attempt < retries:
                time.sleep(_backoff(attempt))
            last_err = e
    raise RuntimeError(f'binary GET {path} failed: {last_err}')


# ---- State (per-table watermarks) ------------------------------------------

def read_state():
    if not STATE_PATH.exists():
        return {'version': 1, 'watermarks': {}}
    try:
        s = json.loads(STATE_PATH.read_text())
    except (json.JSONDecodeError, OSError) as e:
        log.warning('_state.json unreadable (%s) — starting fresh', e)
        return {'version': 1, 'watermarks': {}}
    s.setdefault('watermarks', {})
    return s


def write_state(state):
    state['updated_at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    tmp = STATE_PATH.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(state, indent=2))
    tmp.replace(STATE_PATH)


# ---- Field extractors (handle sysparm_display_value=all envelope) ----------

def field(row, key):
    """Pull the raw value from `{value, display_value}` or a plain scalar."""
    v = row.get(key)
    if isinstance(v, dict):
        return v.get('value')
    return v


def _extract_sid(row):
    return field(row, 'sys_id')


def _extract_updated(row):
    return field(row, 'sys_updated_on')


def _extract_delta(table, row):
    """sys_updated_on for normal tables; sys_created_on for append-only tables
    (sys_audit, sys_journal_field) that don't populate sys_updated_on."""
    return field(row, delta_field_for(table))


# ---- File helpers ----------------------------------------------------------

def _count_lines(path):
    if not path.exists():
        return 0
    n = 0
    with path.open('rb') as f:
        for _ in f:
            n += 1
    return n


def _last_sys_id_in_file(path):
    """Read the tail and return the last row's sys_id (for resumable full pull)."""
    if not path.exists() or path.stat().st_size == 0:
        return None
    size = path.stat().st_size
    chunk = min(1_000_000, size)
    with path.open('rb') as f:
        f.seek(size - chunk)
        tail = f.read().decode('utf-8', errors='ignore')
    lines = [ln for ln in tail.split('\n') if ln.strip()]
    for ln in reversed(lines):
        try:
            return _extract_sid(json.loads(ln))
        except json.JSONDecodeError:
            continue
    return None


def _max_updated_in_file(path, table=None):
    """One-shot scan to find the maximum delta-field value (used on resume)."""
    # Note: this reads the table name from a closure when called via export_*
    # paths; for the standalone signature we keep the field selection
    # backward-compatible by accepting either signature.
    if not path.exists():
        return ''
    max_v = ''
    field_name = delta_field_for(table) if table else 'sys_updated_on'
    with path.open('r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            v = field(row, field_name)
            if v and v > max_v:
                max_v = v
    return max_v


def _write_row(f, row):
    f.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')))
    f.write('\n')


# ---- Page generator (offset-paginated; used for delta pulls) ---------------

def fetch_pages_offset(table, query):
    """Generator yielding pages of rows for the given query."""
    page_size = page_size_for(table)
    offset = 0
    while True:
        params = {
            'sysparm_query': query,
            'sysparm_limit': page_size,
            'sysparm_offset': offset,
            'sysparm_display_value': 'all',
            'sysparm_exclude_reference_link': 'true',
        }
        try:
            payload = api_get_json(f'/api/now/table/{table}', params)
        except urllib.error.HTTPError as e:
            # 404 = endpoint missing. 400 = ServiceNow's "Invalid table"
            # response when the table doesn't exist on this instance
            # (alm_software_license on instances without SAM Pro, for
            # example). Both mean "no such table — export 0 rows" so a
            # missing module doesn't kill the rest of the run.
            if e.code in (400, 404):
                log.warning('  %s: table not available on this instance (HTTP %d)', table, e.code)
                return
            raise
        rows = payload.get('result', [])
        # Defensive: ServiceNow occasionally returns `result` as a string
        # (an error message, an HTML body that snuck through, etc) and
        # `list.extend(string)` would silently add each character as a
        # "row," producing dict-of-character rows that crash the merge.
        if not isinstance(rows, list):
            log.warning('  %s: unexpected result shape %s — stopping page',
                        table, type(rows).__name__)
            return
        rows = [r for r in rows if isinstance(r, dict)]
        if not rows:
            return
        yield rows
        # Use the per-table page size for the early-stop check. Tables with
        # smaller overrides (incident=1000, change_request=1000, …) would
        # otherwise stop after the first page when len(rows) == 1000 since
        # `1000 < PAGE_SIZE(5000)` is True — silently truncating deltas.
        if len(rows) < page_size:
            return
        offset += page_size


# ---- Full pull (cursor by sys_id, resumable) -------------------------------

def export_table_full(table):
    out_path = OUT_DIR / f'{table}.ndjson'
    last_sys_id = _last_sys_id_in_file(out_path)
    written = _count_lines(out_path) if last_sys_id else 0
    max_updated = _max_updated_in_file(out_path, table) if last_sys_id else ''

    if last_sys_id:
        log.info('Resuming full export of %s from sys_id=%s… (%d rows on disk)',
                 table, last_sys_id[:8], written)
        mode = 'a'
    else:
        log.info('Full export %s …', table)
        mode = 'w'
        # If forcing a fresh full pull, truncate existing file
        if FORCE_FULL and out_path.exists():
            out_path.unlink()

    parts = [p for p in (class_filter(table), TABLE_FILTERS.get(table, '')) if p]
    filter_prefix = '^'.join(parts) + '^' if parts else ''
    if parts:
        log.info('  applying filter: %s', '^'.join(parts))

    started = time.time()
    with out_path.open(mode, encoding='utf-8') as f:
        while True:
            cursor_clause = f'sys_id>{last_sys_id}^ORDERBYsys_id' if last_sys_id else 'ORDERBYsys_id'
            query = f'{filter_prefix}{cursor_clause}'
            params = {
                'sysparm_query': query,
                'sysparm_limit': page_size_for(table),
                'sysparm_display_value': 'all',
                'sysparm_exclude_reference_link': 'true',
            }
            try:
                payload = api_get_json(f'/api/now/table/{table}', params)
            except urllib.error.HTTPError as e:
                if e.code in (400, 404):
                    log.warning('  %s: table not available on this instance (HTTP %d) — skipping', table, e.code)
                    return 0, ''
                raise

            rows = payload.get('result', [])
            if not rows:
                break

            for row in rows:
                _write_row(f, row)
                written += 1
                upd = _extract_delta(table, row)
                if upd and upd > max_updated:
                    max_updated = upd

            sid = _extract_sid(rows[-1])
            if not sid:
                log.error('  %s: row has no sys_id — stopping', table)
                break
            last_sys_id = sid
            f.flush()

            elapsed = time.time() - started
            rate = written / elapsed if elapsed else 0
            log.info('  %s: %d rows so far (%.0f/s)', table, written, rate)

            # Don't break on `len(rows) < PAGE_SIZE` — ServiceNow byte-caps
            # very large response payloads (display_value=all on wide tables
            # like incident/change_request can emit 50+ MB pages and the
            # server returns a partial). Only an EMPTY page (rows == [])
            # means we've truly reached the end. The cursor handles dedup.

    log.info('  ✓ %s — %d rows in %ds (watermark=%s)',
             table, written, int(time.time() - started), max_updated or '-')
    return written, max_updated


# ---- Incremental pull (delta since watermark, in-place merge) --------------

def export_table_delta(table, watermark):
    out_path = OUT_DIR / f'{table}.ndjson'
    log.info('Delta export %s (since %s)', table, watermark)
    started = time.time()

    # Order by the delta field (sys_updated_on for normal tables, sys_created_on
    # for append-only tables), then sys_id so duplicate timestamps cursor cleanly.
    df = delta_field_for(table)
    parts = [p for p in (class_filter(table), TABLE_FILTERS.get(table, '')) if p]
    filter_prefix = '^'.join(parts) + '^' if parts else ''
    query = f'{filter_prefix}{df}>={watermark}^ORDERBY{df}^ORDERBYsys_id'

    fetched = []
    for page in fetch_pages_offset(table, query):
        fetched.extend(page)
        log.info('  %s: fetched %d delta rows', table, len(fetched))

    if not fetched:
        rows_total = _count_lines(out_path)
        log.info('  ✓ %s — no changes since %s (%d rows on disk)', table, watermark, rows_total)
        return rows_total, watermark

    # Index new rows by sys_id; track new max watermark
    new_by_sid = {}
    new_max = watermark
    for row in fetched:
        sid = _extract_sid(row)
        if not sid:
            continue
        new_by_sid[sid] = row
        upd = _extract_delta(table, row)
        if upd and upd > new_max:
            new_max = upd

    # Stream the existing file → tmp; replace rows whose sys_id is in new_by_sid;
    # append truly-new rows at the end.
    tmp = out_path.with_suffix('.ndjson.tmp')
    seen = set()
    updated = unchanged = 0
    with out_path.open('r', encoding='utf-8') as fin, tmp.open('w', encoding='utf-8') as fout:
        for line in fin:
            line = line.rstrip('\n')
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            sid = _extract_sid(row)
            if sid and sid in new_by_sid:
                _write_row(fout, new_by_sid[sid])
                seen.add(sid)
                updated += 1
            else:
                fout.write(line + '\n')
                unchanged += 1
        added = 0
        for sid, row in new_by_sid.items():
            if sid not in seen:
                _write_row(fout, row)
                added += 1

    tmp.replace(out_path)
    total = updated + added + unchanged
    log.info('  ✓ %s — %d updated, %d new, %d unchanged in %ds (watermark=%s)',
             table, updated, added, unchanged, int(time.time() - started), new_max)
    return total, new_max


def export_table_delta_parallel(table, watermark):
    """Same shape as export_table_delta — fetch new/updated rows since the
    last watermark, then merge into the existing NDJSON by sys_id. The
    fetch is sharded across 16 sys_id hex prefixes and pulled by
    PARALLEL_WORKERS threads; everything else is identical."""
    out_path = OUT_DIR / f'{table}.ndjson'
    log.info('Delta export %s (since %s) — parallel %d workers',
             table, watermark, PARALLEL_WORKERS)
    started = time.time()

    df = delta_field_for(table)
    parts_filter = [p for p in (class_filter(table), TABLE_FILTERS.get(table, '')) if p]
    filter_prefix = '^'.join(parts_filter) + '^' if parts_filter else ''

    def fetch_shard(prefix):
        # Each shard runs its own paginated cursor over a 1/16th slice of
        # sys_id space. Order by sys_id so duplicate timestamps cursor
        # cleanly within the shard.
        query = (f'{filter_prefix}sys_idSTARTSWITH{prefix}^'
                 f'{df}>={watermark}^ORDERBYsys_id')
        rows = []
        for page in fetch_pages_offset(table, query):
            rows.extend(page)
        return prefix, rows

    fetched = []
    shards = list('0123456789abcdef')
    with ThreadPoolExecutor(max_workers=PARALLEL_WORKERS) as ex:
        futures = {ex.submit(fetch_shard, p): p for p in shards}
        for fut in as_completed(futures):
            prefix, rows = fut.result()
            fetched.extend(rows)
            log.info('  %s: shard %s done — %d rows (running total: %d)',
                     table, prefix, len(rows), len(fetched))

    if not fetched:
        rows_total = _count_lines(out_path)
        log.info('  ✓ %s — no changes since %s (%d rows on disk)',
                 table, watermark, rows_total)
        return rows_total, watermark

    new_by_sid = {}
    new_max = watermark
    for row in fetched:
        sid = _extract_sid(row)
        if not sid:
            continue
        new_by_sid[sid] = row
        upd = _extract_delta(table, row)
        if upd and upd > new_max:
            new_max = upd

    tmp = out_path.with_suffix('.ndjson.tmp')
    seen = set()
    updated = unchanged = 0
    with out_path.open('r', encoding='utf-8') as fin, tmp.open('w', encoding='utf-8') as fout:
        for line in fin:
            line = line.rstrip('\n')
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            sid = _extract_sid(row)
            if sid and sid in new_by_sid:
                _write_row(fout, new_by_sid[sid])
                seen.add(sid)
                updated += 1
            else:
                fout.write(line + '\n')
                unchanged += 1
        added = 0
        for sid, row in new_by_sid.items():
            if sid not in seen:
                _write_row(fout, row)
                added += 1

    tmp.replace(out_path)
    total = updated + added + unchanged
    log.info('  ✓ %s — %d updated, %d new, %d unchanged in %ds (watermark=%s)',
             table, updated, added, unchanged, int(time.time() - started), new_max)
    return total, new_max


# ---- Dispatcher ------------------------------------------------------------

def export_table(table, state):
    out_path    = OUT_DIR / f'{table}.ndjson'
    watermarks  = state.setdefault('watermarks', {})
    watermark   = None if FORCE_FULL else watermarks.get(table)

    if watermark and out_path.exists():
        if table in PARALLEL_TABLES:
            count, new_watermark = export_table_delta_parallel(table, watermark)
        else:
            count, new_watermark = export_table_delta(table, watermark)
    elif table in PARALLEL_TABLES:
        count, new_watermark = export_table_parallel(table)
    else:
        count, new_watermark = export_table_full(table)

    if new_watermark:
        watermarks[table] = new_watermark
        write_state(state)

    return count


# ---- Parallel pull (hex-prefix sharding) ----------------------------------

def _fetch_shard(table, prefix):
    """Pull every row of `table` whose sys_id starts with hex `prefix` into
    a per-shard NDJSON file. Resumable via the shard file's last sys_id.
    Returns (rows_written, max_sys_updated_on)."""
    shard_path = OUT_DIR / f'{table}.shard{prefix}.ndjson'
    last_sys_id = _last_sys_id_in_file(shard_path)
    written = _count_lines(shard_path) if last_sys_id else 0
    max_updated = _max_updated_in_file(shard_path, table) if last_sys_id else ''
    mode = 'a' if last_sys_id else 'w'

    if last_sys_id:
        log.info('  [shard %s] resuming from sys_id=%s… (%d on disk)',
                 prefix, last_sys_id[:8], written)
    else:
        log.info('  [shard %s] starting', prefix)

    started = time.time()
    last_log = 0
    with shard_path.open(mode, encoding='utf-8') as f:
        while True:
            parts = [f'sys_idSTARTSWITH{prefix}']
            cls = class_filter(table)
            if cls: parts.append(cls)
            base = TABLE_FILTERS.get(table, '')
            if base: parts.append(base)
            if last_sys_id: parts.append(f'sys_id>{last_sys_id}')
            parts.append('ORDERBYsys_id')

            params = {
                'sysparm_query': '^'.join(parts),
                'sysparm_limit': page_size_for(table),
                'sysparm_display_value': 'all',
                'sysparm_exclude_reference_link': 'true',
            }

            try:
                payload = api_get_json(f'/api/now/table/{table}', params)
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    log.warning('  [shard %s] table not present (404)', prefix)
                    return 0, ''
                raise

            rows = payload.get('result', [])
            if not rows:
                break

            for row in rows:
                _write_row(f, row)
                written += 1
                upd = _extract_delta(table, row)
                if upd and upd > max_updated:
                    max_updated = upd

            sid = _extract_sid(rows[-1])
            if not sid:
                log.error('  [shard %s] row missing sys_id', prefix)
                break
            last_sys_id = sid
            f.flush()

            # Throttle progress logging — parallel workers spamming the log
            # at every page is unreadable. Log every ~10k rows.
            if written - last_log >= 10000:
                rate = written / (time.time() - started) if (time.time() - started) else 0
                log.info('  [shard %s] %d rows so far (%.0f/s)', prefix, written, rate)
                last_log = written

    log.info('  ✓ [shard %s] %d rows (watermark=%s)', prefix, written, max_updated or '-')
    return written, max_updated


def export_table_parallel(table):
    """Hex-prefix sharded parallel pull. Spawns up to PARALLEL_WORKERS threads,
    each processing a shard (sys_idSTARTSWITH<hex>). Concatenates the per-shard
    NDJSON files into <table>.ndjson on success."""
    out_path = OUT_DIR / f'{table}.ndjson'
    shards = list('0123456789abcdef')

    # Existing flat NDJSON from a prior sequential run can't be merged with
    # shards reliably (cursor halfway through a shard's range = double-pull).
    # Move it aside so a clean parallel pull replaces it.
    if out_path.exists():
        salvage = out_path.with_suffix('.ndjson.flat-salvaged')
        log.warning('Parallel pull of %s: moving existing %s -> %s '
                    '(shards will replace it)',
                    table, out_path.name, salvage.name)
        out_path.replace(salvage)

    log.info('Parallel export %s — %d shards × up to %d concurrent workers',
             table, len(shards), PARALLEL_WORKERS)
    started = time.time()

    results = {}
    with ThreadPoolExecutor(max_workers=PARALLEL_WORKERS) as ex:
        futures = {ex.submit(_fetch_shard, table, p): p for p in shards}
        for fut in as_completed(futures):
            p = futures[fut]
            count, max_upd = fut.result()  # propagate exceptions
            results[p] = (count, max_upd)

    # All shards complete — merge them into the final NDJSON.
    log.info('  merging %d shards into %s …', len(shards), out_path.name)
    total_rows = 0
    max_updated_all = ''
    with out_path.open('w', encoding='utf-8') as out:
        for p in shards:
            sp = OUT_DIR / f'{table}.shard{p}.ndjson'
            if not sp.exists():
                continue
            with sp.open('r', encoding='utf-8') as src:
                for line in src:
                    out.write(line)
            count, max_upd = results.get(p, (0, ''))
            total_rows += count
            if max_upd and max_upd > max_updated_all:
                max_updated_all = max_upd
            sp.unlink()

    log.info('  ✓ %s — %d rows in %ds (watermark=%s)',
             table, total_rows, int(time.time() - started),
             max_updated_all or '-')
    return total_rows, max_updated_all


# ---- Attachment file bodies (LAST; naturally incremental) ------------------

_SAFE_CHARS = set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-')


def _safe_name(name):
    if not name:
        return 'file'
    cleaned = ''.join(c if c in _SAFE_CHARS else '_' for c in name)
    return cleaned[:200] or 'file'


def _attachment_path(sid, file_name):
    shard = (sid[:2] or '__').lower()
    return ATTACH_DIR / shard / sid / _safe_name(file_name)


def _download_one_attachment(row):
    """Worker: fetch one attachment file body. Returns (outcome, err_or_none)
    where outcome is 'written' | 'skipped' | 'failed'. Resume-safe: target
    file existence is checked before any HTTP request, so a re-run with
    files already on disk skips them at near-disk-stat speed."""
    sid = _extract_sid(row)
    file_name = field(row, 'file_name')
    if not sid:
        return ('skipped', None)
    target = _attachment_path(sid, file_name)
    if target.exists() and (target.is_symlink() or target.stat().st_size > 0):
        return ('skipped', None)
    try:
        blob, _ctype = api_get_binary(f'/api/now/attachment/{sid}/file')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(blob)
        return ('written', None)
    except Exception as e:
        return ('failed', f'attachment {sid[:8]} ({file_name}): {e}')


def _symlink_secondary(sec_sid, sec_file_name, primary_sid, primary_file_name):
    """For a non-primary attachment that has the same content hash as a
    primary we already downloaded, write a relative symlink pointing at the
    primary's bytes. Saves the disk space without breaking the per-sys_id
    URL the viewer requests."""
    sec_target = _attachment_path(sec_sid, sec_file_name)
    if sec_target.exists() or sec_target.is_symlink():
        return ('skipped', None)
    primary_target = _attachment_path(primary_sid, primary_file_name)
    if not primary_target.exists():
        # Primary download failed or hasn't happened. Skip; a future run
        # will retry the primary and then this symlink can land.
        return ('failed', f'no primary for {sec_sid[:8]} → {primary_sid[:8]}')
    try:
        sec_target.parent.mkdir(parents=True, exist_ok=True)
        rel = os.path.relpath(primary_target, sec_target.parent)
        sec_target.symlink_to(rel)
        return ('linked', None)
    except Exception as e:
        return ('failed', f'symlink {sec_sid[:8]}: {e}')


def export_attachment_bodies():
    if SKIP_ATTACH:
        log.info('Skipping attachment bodies (SN_SKIP_ATTACHMENTS=1)')
        return
    meta_path = OUT_DIR / 'sys_attachment.ndjson'
    if not meta_path.exists():
        log.warning('No sys_attachment.ndjson — skipping bodies')
        return

    ATTACH_DIR.mkdir(exist_ok=True)

    # ---- Phase 0: scan metadata, dedupe by content hash ----
    # ServiceNow's sys_attachment.hash is the SHA1 of the file content. Email
    # signature images / Outlook image001.png stubs / corporate logos repeat
    # thousands of times across email-imported tickets. Downloading every
    # one wastes both bandwidth and disk. Strategy: pick ONE canonical
    # sys_id per hash (lowest-sorted for determinism across re-runs),
    # download only those, then symlink the rest.
    log.info('Scanning sys_attachment metadata for hash-dedup…')
    primaries = []          # rows we'll actually download
    secondaries = []        # (sec_sid, sec_file_name, primary_sid, primary_file_name)
    no_hash = 0
    total = 0
    primary_for_hash = {}   # hash → (sid, file_name); winners are sorted-low
    rows_pending_hash = []  # rows that need a second pass once primaries are picked

    # First pass: collect winners. Sort by sys_id so the choice is stable
    # across re-runs (otherwise a future re-run might pick a different
    # primary and re-download a near-duplicate set).
    all_rows = []
    with meta_path.open('r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            sid = _extract_sid(r)
            if not sid:
                continue
            all_rows.append((sid, field(r, 'hash') or '', field(r, 'file_name') or ''))
    all_rows.sort(key=lambda t: t[0])
    total = len(all_rows)
    for sid, h, fname in all_rows:
        if not h:
            primaries.append((sid, fname))
            no_hash += 1
            continue
        if h not in primary_for_hash:
            primary_for_hash[h] = (sid, fname)
            primaries.append((sid, fname))
        else:
            psid, pname = primary_for_hash[h]
            secondaries.append((sid, fname, psid, pname))

    log.info(
        'attachments: %d total → %d primaries (%d unique hashes) + '
        '%d secondaries (symlinks) + %d no-hash. dedup avoids %d HTTP fetches.',
        total, len(primaries), len(primary_for_hash),
        len(secondaries), no_hash, len(secondaries),
    )

    workers = int(os.environ.get('SN_ATTACHMENT_WORKERS', '8'))

    # ---- Phase 1: download primaries in parallel ----
    log.info('Phase 1: downloading %d primary attachments with %d workers '
             '(resume-safe; Ctrl+C is OK)', len(primaries), workers)
    written = skipped = failed = 0
    started = time.time()

    from concurrent.futures import wait as fut_wait, FIRST_COMPLETED
    inflight_cap = max(workers * 4, 16)
    pending = set()
    log_every = 200

    # Build a synthetic "row" dict the worker expects. Cheaper than re-parsing
    # the JSON row; we already have sid + file_name.
    def _row_for(sid, fname):
        return {
            'sys_id': {'value': sid},
            'file_name': {'value': fname},
        }

    def _drain(pending, total_for_log):
        nonlocal written, skipped, failed
        done, pending = fut_wait(pending, return_when=FIRST_COMPLETED)
        for fut in done:
            outcome, err = fut.result()
            if outcome == 'written':
                written += 1
            elif outcome == 'skipped':
                skipped += 1
            else:
                failed += 1
                if err:
                    log.error('  %s', err)
            done_count = written + skipped + failed
            if done_count % log_every == 0:
                elapsed = time.time() - started
                rate = (written + skipped) / elapsed if elapsed else 0
                eta = (total_for_log - done_count) / rate if rate else None
                log.info('  primaries: %d downloaded, %d skipped, '
                         '%d failed of %d (%.1f/s%s)',
                         written, skipped, failed, total_for_log, rate,
                         f', ETA {int(eta)}s' if eta else '')
        return pending

    try:
        with ThreadPoolExecutor(max_workers=workers) as ex:
            for sid, fname in primaries:
                pending.add(ex.submit(_download_one_attachment, _row_for(sid, fname)))
                if len(pending) >= inflight_cap:
                    pending = _drain(pending, len(primaries))
            while pending:
                pending = _drain(pending, len(primaries))
    except KeyboardInterrupt:
        log.warning('  primaries: interrupted at %d/%d (resumable; '
                    're-run to continue)', written + skipped + failed,
                    len(primaries))
        raise

    log.info('  ✓ Phase 1 — %d downloaded, %d skipped, %d failed in %ds',
             written, skipped, failed, int(time.time() - started))

    # ---- Phase 2: create symlinks for secondaries ----
    if not secondaries:
        return
    log.info('Phase 2: linking %d secondary attachments (no HTTP)',
             len(secondaries))
    started2 = time.time()
    linked = link_skipped = link_failed = 0
    for sec_sid, sec_fname, psid, pname in secondaries:
        outcome, err = _symlink_secondary(sec_sid, sec_fname, psid, pname)
        if outcome == 'linked':
            linked += 1
        elif outcome == 'skipped':
            link_skipped += 1
        else:
            link_failed += 1
            if err:
                log.warning('  %s', err)
        if (linked + link_skipped + link_failed) % 5000 == 0:
            log.info('  symlinks: %d linked, %d skipped, %d failed of %d',
                     linked, link_skipped, link_failed, len(secondaries))
    log.info('  ✓ Phase 2 — %d linked, %d skipped, %d failed in %ds',
             linked, link_skipped, link_failed, int(time.time() - started2))


# ---- Manifest --------------------------------------------------------------

def write_manifest(counts, state):
    """Merge a fresh entry per just-exported table with the prior manifest's
    entries for tables we didn't run this time. Without the merge, a
    selective run with SN_TABLES=foo,bar would shrink manifest.json to
    just those two tables — wiping the home-page tiles, sidebar counts,
    and snapshot integrity panel for everything else."""
    prev_path = OUT_DIR / 'manifest.json'
    prev_tables_by_name = {}
    try:
        prev = json.loads(prev_path.read_text(encoding='utf-8'))
        for t in prev.get('tables', []):
            if isinstance(t, dict) and t.get('table'):
                prev_tables_by_name[t['table']] = t
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    fresh = {
        t: {
            'table': t,
            'rows': counts.get(t, 0),
            'source_rows': counts.get(t, 0),
            'watermark': state.get('watermarks', {}).get(t, ''),
        }
        for t in TABLES
    }
    # Merge: every previously-known table stays; ones we just ran get
    # overwritten with fresh counts/watermarks. Order is "previously
    # known" first (preserves the prior layout), then any net-new tables
    # this run discovered.
    merged_order = list(prev_tables_by_name.keys())
    for t in TABLES:
        if t not in prev_tables_by_name:
            merged_order.append(t)
    tables = [
        fresh.get(t) or prev_tables_by_name[t]
        for t in merged_order
    ]

    integrity = {'sha256_manifest': '', 'acl_skips': 0, 'missing_attachments': 0}
    # Carry forward integrity counts on partial runs so the panel doesn't
    # zero out when SN_TABLES is set.
    prev_int = (json.loads(prev_path.read_text(encoding='utf-8')).get('integrity', {})
                if prev_path.exists() else {})
    if prev_int and len(TABLES) < len(prev_tables_by_name):
        integrity = {**integrity, **prev_int}

    manifest = {
        'label': os.environ.get('SN_MANIFEST_LABEL', 'export'),
        'snapshot_date': time.strftime('%Y-%m-%d'),
        'instance': INSTANCE,
        'captured_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'tables': tables,
        'integrity': integrity,
    }
    prev_path.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    log.info('Wrote manifest.json (%d tables; %d this run)',
             len(manifest['tables']), len(TABLES))


# ---- Main ------------------------------------------------------------------

def main():
    state = read_state()
    has_state = bool(state.get('watermarks'))
    mode = 'FULL (forced)' if FORCE_FULL else ('INCREMENTAL' if has_state else 'FULL (first run)')

    log.info('Instance:    %s', INSTANCE)
    log.info('Output dir:  %s', OUT_DIR)
    log.info('Mode:        %s', mode)
    log.info('Tables (%d): %s', len(TABLES), ', '.join(TABLES))

    counts = {}
    interrupted = False
    try:
        for table in TABLES:
            try:
                counts[table] = export_table(table, state)
            except Exception as e:
                log.error('Table %s failed (continuing): %s', table, e)
                counts[table] = _count_lines(OUT_DIR / f'{table}.ndjson')
    except KeyboardInterrupt:
        log.warning('Interrupted during table export.')
        interrupted = True

    write_manifest(counts, state)

    if interrupted:
        log.warning('Skipping attachment bodies due to interrupt.')
        return

    try:
        export_attachment_bodies()
    except KeyboardInterrupt:
        log.warning('Cancelled attachment download — '
                    'all other exported data is intact in %s', OUT_DIR)


if __name__ == '__main__':
    main()
