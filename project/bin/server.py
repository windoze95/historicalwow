#!/usr/bin/env python3
"""
HistoricalWow web server — serves the static viewer + a thin API over SQLite.

Replaces nginx in the container. Single Python process, stdlib only
(http.server, sqlite3, json). Routes:

  GET /                          → /HistoricalWow.html
  GET /HistoricalWow.html        → static
  GET /api/manifest              → contents of data/manifest.json
  GET /api/<table>?limit=&offset=&q=&...  → paginated SELECT
  GET /api/<table>/<sys_id>      → single record by sys_id
  GET /api/journal/<element_id>  → journal entries for a record (any table)
  GET /api/audit/<documentkey>   → audit entries for a record
  GET /api/attachments/<table_sys_id>  → attachment metadata for a record
  GET /api/related/cmdb/<sys_id> → upstream + downstream CI relationships
  GET /api/variables/<ritm_sys_id> → catalog variables submitted on an RITM
  GET /api/search?q=...&types=incident,problem  → cross-table search
  GET /data/attachments/<...>    → attachment file body (filesystem)
  GET /data/manifest.json        → manifest (compatibility shim for legacy data.js)

DB: /app/data/historicalwow.db (built by bin/build_sqlite.py).
Static root: /app (HistoricalWow.html lives here).
Attachments root: /app/data/attachments (mirror of host disk via volume mount).
"""
import datetime
import base64
import gzip
import hmac
import json
import logging
import logging.handlers
import os
import re
import secrets
import socket
import sqlite3
import sys
import threading
import time
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


APP_DIR    = Path(os.environ.get('HISTORICALWOW_APP', '/app')).resolve()
DATA_DIR   = APP_DIR / 'data'
DB_PATH    = DATA_DIR / 'historicalwow.db'
STATIC_HTML = APP_DIR / 'HistoricalWow.html'

PORT = int(os.environ.get('HISTORICALWOW_PORT', '80'))

# --- Access log -----------------------------------------------------------
# One JSON line per request to a rotating file. Default on; set
# HISTORICALWOW_ACCESS_LOG="" to disable. Reverse-DNS is the only realistic
# source of caller identity (no auth in front of this service); set
# HISTORICALWOW_ACCESS_LOG_DNS=0 to skip lookups if corp DNS is slow or
# unreliable, in which case the `host` field is logged as "-" and the
# /api/whoami endpoint returns null.
ACCESS_LOG_PATH    = os.environ.get('HISTORICALWOW_ACCESS_LOG', '/app/logs/access.log').strip()
ACCESS_LOG_DNS     = os.environ.get('HISTORICALWOW_ACCESS_LOG_DNS', '1') != '0'
ACCESS_LOG_MAX     = int(os.environ.get('HISTORICALWOW_ACCESS_LOG_MAX_BYTES', str(10 * 1024 * 1024)))
ACCESS_LOG_BACKUPS = int(os.environ.get('HISTORICALWOW_ACCESS_LOG_BACKUPS', '5'))
# X-Forwarded-For is trusted ONLY when this service sits behind a proxy that
# sets it. The container is directly reachable today, so default OFF: a
# direct client can set any XFF value it likes, and honoring it would let
# callers forge the logged/displayed IP and hostname — defeating the point
# of an audit log. Set HISTORICALWOW_TRUST_PROXY=1 once a trusted reverse
# proxy terminates connections in front of this server.
TRUST_PROXY        = os.environ.get('HISTORICALWOW_TRUST_PROXY', '0') == '1'

# --- HR gate --------------------------------------------------------------
# Incidents assigned to this group (sys_user_group.sys_id) are hidden from
# every API response unless the requesting browser holds a valid hr_unlock
# cookie. Token is set when the user POSTs the correct password to
# /api/hr-unlock; tokens live in process memory and are wiped on restart.
HR_GROUP_SYS_ID    = os.environ.get('HR_GROUP_SYS_ID', '356fce0a4fcd255057a8847221ad48de')
HR_UNLOCK_PASSWORD = os.environ.get('HR_UNLOCK_PASSWORD', '')
HR_GROUP_LABEL     = os.environ.get('HR_GROUP_LABEL', 'IT - HR Support')

_hr_tokens: set[str] = set()
_hr_tokens_lock = threading.Lock()


# --- Lookup cache ---------------------------------------------------------
# Precomputed gzipped JSON bytes for the boot-time lookup endpoints. These
# are big (cmdb_ci_lookup scans 1M rows; sys_user_lookup ~140k) and the
# work is the same for every browser, so doing it once per DB rebuild
# turns a 6-second SQL+encode+gzip call into a memcpy.
#
# Cache key = absolute db_mtime. Any rebuild of historicalwow.db (which
# bumps the mtime via SQLite's atomic rename / tempfile path) invalidates
# every entry. New requests rebuild on demand; the warmup thread below
# pre-populates the heavy ones at server startup so the first user
# doesn't pay the cold-miss cost.
_lookup_cache: dict = {}  # endpoint_id → (db_mtime, gz_bytes, etag)
_lookup_cache_lock = threading.Lock()


def _db_mtime() -> float:
    return DB_PATH.stat().st_mtime if DB_PATH.exists() else 0.0


def _serve_cached_lookup(handler, endpoint_id: str, builder, max_age: int = 3600):
    """Serve a lookup JSON endpoint from the in-memory cache, building if
    needed. `builder` is a no-arg callable returning a JSON-serializable
    Python object. Browser cache validates via ETag (cheap 304s).

    The builder runs OUTSIDE _lookup_cache_lock — the lock only guards the
    dict read/write. This matters because the lock is shared across every
    lookup endpoint: if a slow builder (e.g. cmdb_metrics on a multi-million
    row DB) held it, an unrelated /api/manifest — the viewer's boot fetch —
    would block behind it and the whole app would hang on "loading". The cost
    is that two cold requests for the same endpoint may build redundantly; the
    builds are cheap and the startup warmer pre-populates the heavy ones, so
    that's a fine trade for never head-of-line-blocking the app."""
    mtime = _db_mtime()
    with _lookup_cache_lock:
        cached = _lookup_cache.get(endpoint_id)
    if not cached or cached[0] != mtime:
        payload = builder()
        body = json.dumps(payload, default=str, ensure_ascii=False).encode('utf-8')
        gz_bytes = gzip.compress(body, compresslevel=6)
        etag = f'W/"{int(mtime)}-{len(gz_bytes)}"'
        cached = (mtime, gz_bytes, etag)
        with _lookup_cache_lock:
            _lookup_cache[endpoint_id] = cached
        log.info('lookup cache built %s — %d bytes gz', endpoint_id, len(gz_bytes))
    _, gz_bytes, etag = cached

    # Browser revalidation — if the client's ETag matches, ship 304.
    if handler.headers.get('If-None-Match', '') == etag:
        handler.send_response(HTTPStatus.NOT_MODIFIED)
        handler.send_header('ETag', etag)
        handler.send_header('Cache-Control', f'public, max-age={max_age}')
        handler.end_headers()
        return

    handler.send_response(HTTPStatus.OK)
    handler.send_header('Content-Type', 'application/json; charset=utf-8')
    handler.send_header('Content-Encoding', 'gzip')
    handler.send_header('Content-Length', str(len(gz_bytes)))
    handler.send_header('Cache-Control', f'public, max-age={max_age}')
    handler.send_header('ETag', etag)
    handler.end_headers()
    handler.wfile.write(gz_bytes)


def warm_lookup_cache():
    """Populate the heavy lookup caches at server startup so the first
    user request hits memory, not SQLite. Runs in a background thread —
    if it errors, the next user's request just builds it on demand."""
    try:
        log.info('warming lookup cache…')
        _lookup_cache_set('manifest',         lambda: _build_manifest_payload())
        _lookup_cache_set('sys_user_lookup',  lambda: _build_sys_user_lookup_payload())
        _lookup_cache_set('cmdb_ci_lookup',   lambda: _build_cmdb_ci_lookup_payload())
        _lookup_cache_set('cmdb_metrics',     lambda: _build_cmdb_metrics_payload())
        log.info('lookup cache warm')
    except Exception as e:
        log.warning('lookup cache warmup failed: %s (will lazy-build on demand)', e)


def _lookup_cache_set(endpoint_id, builder):
    mtime = _db_mtime()
    payload = builder()
    body = json.dumps(payload, default=str, ensure_ascii=False).encode('utf-8')
    gz_bytes = gzip.compress(body, compresslevel=6)
    etag = f'W/"{int(mtime)}-{len(gz_bytes)}"'
    with _lookup_cache_lock:
        _lookup_cache[endpoint_id] = (mtime, gz_bytes, etag)
    log.info('lookup cache pre-built %s — %d bytes gz', endpoint_id, len(gz_bytes))

# Log to stdout so docker logs picks it up.
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)-7s %(message)s',
    datefmt='%H:%M:%S',
    stream=sys.stdout,
)
log = logging.getLogger('historicalwow.server')

# Access log is a separate sink so the operational stderr stream and the
# durable request log don't intermix. `propagate=False` keeps records out of
# the root logger's stdout handler set up above.
access_log = logging.getLogger('historicalwow.access')
access_log.propagate = False
access_log.setLevel(logging.INFO)
if ACCESS_LOG_PATH:
    try:
        Path(ACCESS_LOG_PATH).parent.mkdir(parents=True, exist_ok=True)
        _h = logging.handlers.RotatingFileHandler(
            ACCESS_LOG_PATH, maxBytes=ACCESS_LOG_MAX,
            backupCount=ACCESS_LOG_BACKUPS, encoding='utf-8',
        )
        _h.setFormatter(logging.Formatter('%(message)s'))
        access_log.addHandler(_h)
    except OSError as e:
        log.warning('access log disabled (%s): %s', ACCESS_LOG_PATH, e)
        ACCESS_LOG_PATH = ''

# Reverse-DNS cache. Cold lookups can block 1–2s; cache aggressively and
# only resolve once per IP per hour. Bounded to 256 entries to keep memory
# trivial — a corporate viewer rarely sees that many distinct clients.
_DNS_TTL = 3600
_DNS_MAX = 256
_dns_cache: dict = {}  # ip -> (host, expires_at)
_dns_lock = threading.Lock()


def _reverse_dns(ip: str) -> str:
    """Best-effort PTR lookup, cached. Returns '-' on failure or when
    HISTORICALWOW_ACCESS_LOG_DNS is disabled."""
    if not ACCESS_LOG_DNS or not ip:
        return '-'
    now = time.time()
    with _dns_lock:
        cached = _dns_cache.get(ip)
        if cached and cached[1] > now:
            return cached[0]
    try:
        host = socket.gethostbyaddr(ip)[0]
    except (socket.herror, socket.gaierror, OSError):
        host = '-'
    with _dns_lock:
        if len(_dns_cache) >= _DNS_MAX:
            # Evict the soonest-expiring entry; cheap O(n) over a tiny dict.
            victim = min(_dns_cache.items(), key=lambda kv: kv[1][1])[0]
            _dns_cache.pop(victim, None)
        _dns_cache[ip] = (host, now + _DNS_TTL)
    return host


def _client_ip(handler) -> str:
    """Source IP for logging/identity. Uses the TCP peer address, which a
    client can't forge without network-level spoofing. X-Forwarded-For is
    honored only when HISTORICALWOW_TRUST_PROXY=1 — otherwise a direct
    caller could spoof it and poison the audit log."""
    peer = handler.client_address[0] if handler.client_address else '-'
    if TRUST_PROXY:
        xff = handler.headers.get('X-Forwarded-For', '')
        if xff:
            return xff.split(',')[0].strip()
    return peer


# Tables we serve via /api/<table>. Keep in sync with bin/build_sqlite.py.
TASK_TABLES = {
    'incident', 'change_request', 'problem', 'problem_task',
    'sc_request', 'sc_req_item', 'sc_task',
    'incident_task', 'change_task',
    'sysapproval_group', 'asset_task',
    # All concrete asset_task descendants on this instance carry
    # `sys_class_name=sn_contract_renewal_task` (CMRTASK number prefix),
    # so the asset_task list is empty and the actual records live here.
    'sn_contract_renewal_task',
}
REFERENCE_TABLES = {
    'sys_user', 'sys_user_group', 'sys_user_grmember', 'sys_user_delegate',
    'sys_user_has_role', 'sys_user_role', 'sys_group_has_role',
    'kb_knowledge',
    'cmdb_ci', 'cmdb_rel_ci',
    'sys_choice', 'core_company', 'cmn_department', 'cmn_location', 'cmn_cost_center',
    'sys_journal_field', 'sys_audit', 'sys_attachment', 'sys_email',
    'task_ci', 'task_sla', 'sysapproval_approver',
    'sc_cat_item', 'item_option_new', 'sc_item_option', 'sc_item_option_mtom',
    'question', 'question_choice',
    # Catalog admin metadata — drives the related-list tabs on a sc_cat_item
    # record view. Pulled by the exporter; ingested by build_sqlite.py.
    'sc_catalog', 'sc_category',
    'catalog_ui_policy', 'catalog_ui_policy_action',
    'catalog_script_client',
    'user_criteria',
    'sc_cat_item_user_criteria_mtom', 'sc_cat_item_user_criteria_no_mtom',
    'item_option_new_set', 'io_set_item', 'topic',
    # std_change_proposal bridges change_request back to a
    # std_change_record_producer via template_name = sc_cat_item.name.
    'std_change_proposal',
    'alm_asset', 'alm_hardware', 'alm_software_license', 'alm_license',
    'alm_consumable', 'alm_facility', 'alm_stockroom',
    # sn_ent_facility_asset is an alm_asset descendant (facility plugin —
    # security cameras, IoT, access control). Pulled with sys_class_name
    # filtering so its rows have their own NDJSON/table.
    'sn_ent_facility_asset',
    'cmdb_ci_spkg', 'cmdb_software_instance',
    # Server-side logic — business rules, client scripts, script includes,
    # scheduled scripts, UI policies, data policies. Lets the per-table
    # inspector answer "what runs on this table?" after the source instance
    # is gone.
    'sys_script', 'sys_script_client', 'sys_script_include',
    'sysauto_script',
    'sys_ui_policy', 'sys_ui_policy_action',
    'sys_data_policy2', 'sys_data_policy_rule',
    # Server-side context — instance properties, UI actions, dictionary
    # (field defs + per-table overrides), Flow Designer flows. Feeds the
    # per-table inspector and the LLM-prompt builder; sys_dictionary is
    # the big one (~300k rows) since it covers every field on every table.
    'sys_properties', 'sys_ui_action',
    'sys_dictionary', 'sys_dictionary_override',
    'sys_hub_flow',
    # flow_inventory: derived, curated + enriched per-flow inventory (built by
    # bin/gen_flow_inventory.py, not the exporter). Served like any other table.
    'flow_inventory',
    # Raw Flow Designer internals (steps / triggers / logic) behind each flow.
    'sys_hub_action_instance_v2', 'sys_hub_action_instance',
    'sys_hub_trigger_instance', 'sys_hub_trigger_instance_v2',
    'sys_hub_flow_logic',
    'sys_security_acl',
    # Inbound email actions — rules that turn an inbound email into a record action.
    'sysevent_in_email_action',
    # Outbound notifications, record templates, CI outages, standard-change
    # record producers, and SLA definitions.
    'sysevent_email_action', 'sys_template', 'cmdb_ci_outage',
    'std_change_record_producer', 'contract_sla',
}
ALL_TABLES = TASK_TABLES | REFERENCE_TABLES


# Per-thread DB connections (sqlite3 doesn't share connections across threads).
_local = threading.local()

def get_conn():
    conn = getattr(_local, 'conn', None)
    if conn is None:
        # Read-only URI open. The mount is rw (SQLite needs to coordinate
        # -shm/-wal files even when the app only SELECTs), but `mode=ro`
        # ensures the application can never actually mutate data. URI
        # paths must be absolute and forward-slash; sqlite3 handles that
        # since DB_PATH is already a Path on a POSIX volume.
        uri = f'file:{DB_PATH}?mode=ro'
        conn = sqlite3.connect(uri, uri=True, check_same_thread=False, timeout=30.0)
        conn.row_factory = sqlite3.Row
        _local.conn = conn
    return conn


def _table_exists(conn, table):
    """True once the physical table has been built into the DB. A table can be
    in ALL_TABLES (allowed by the API) yet absent from the DB during the window
    after this code deploys and before the next export/build loads it —
    build_sqlite skips creating a table whose NDJSON file doesn't exist yet.
    Querying a missing table raises `no such table` → HTTP 500 (which the
    viewer's apiGet then retries), so callers gate on this and treat an
    allowed-but-unbuilt table as empty."""
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone() is not None


# --- helpers --------------------------------------------------------------

def _json_response(handler, payload, status=HTTPStatus.OK, cache_seconds=0):
    body = json.dumps(payload, default=str, ensure_ascii=False).encode('utf-8')
    # gzip compress when the client accepts it AND the body is big enough to
    # be worth it. JSON of NDJSON envelope shape compresses 5-8×.
    accept = handler.headers.get('Accept-Encoding', '') or ''
    if len(body) > 4096 and 'gzip' in accept:
        body = gzip.compress(body, compresslevel=4)
        encoding = 'gzip'
    else:
        encoding = None
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/json; charset=utf-8')
    if encoding:
        handler.send_header('Content-Encoding', encoding)
    handler.send_header('Content-Length', str(len(body)))
    if cache_seconds > 0:
        handler.send_header('Cache-Control', f'public, max-age={cache_seconds}')
    else:
        handler.send_header('Cache-Control', 'no-cache, must-revalidate')
    handler.end_headers()
    handler.wfile.write(body)


def _send_static(handler, path, content_type=None, vary=None):
    if not path.is_file():
        return _send_error(handler, HTTPStatus.NOT_FOUND, f'not found: {path.name}')
    if content_type is None:
        ext = path.suffix.lower()
        content_type = {
            '.html': 'text/html; charset=utf-8',
            '.css':  'text/css; charset=utf-8',
            '.js':   'application/javascript; charset=utf-8',
            '.json': 'application/json; charset=utf-8',
            '.yaml': 'application/yaml; charset=utf-8',
            '.png':  'image/png',
            '.jpg':  'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.svg':  'image/svg+xml',
            '.ico':  'image/x-icon',
            '.pdf':  'application/pdf',
            '.txt':  'text/plain; charset=utf-8',
            '.log':  'text/plain; charset=utf-8',
            '.eml':  'message/rfc822',
            '.csv':  'text/csv',
        }.get(ext, 'application/octet-stream')
    size = path.stat().st_size
    handler.send_response(HTTPStatus.OK)
    handler.send_header('Content-Type', content_type)
    handler.send_header('Content-Length', str(size))
    # Vary tells intermediate caches (browser HTTP cache, proxies, CDNs) to
    # key responses by the listed request headers. Required whenever a
    # single URL returns different bodies based on a header (e.g. /docs/<file>.md
    # picking between rendered viewer and raw markdown via Accept).
    if vary:
        handler.send_header('Vary', vary)
    if path.suffix.lower() == '.html':
        handler.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
    handler.end_headers()
    with path.open('rb') as f:
        while True:
            chunk = f.read(64 * 1024)
            if not chunk:
                break
            handler.wfile.write(chunk)


def _send_error(handler, status, msg):
    body = json.dumps({'error': msg}).encode('utf-8')
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/json; charset=utf-8')
    handler.send_header('Content-Length', str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _parse_cookies(handler):
    raw = handler.headers.get('Cookie', '') or ''
    out = {}
    for part in raw.split(';'):
        part = part.strip()
        if '=' in part:
            k, _, v = part.partition('=')
            out[k.strip()] = v.strip()
    return out


def hr_gate_enabled() -> bool:
    return bool(HR_UNLOCK_PASSWORD)


def is_hr_unlocked(handler) -> bool:
    """True if the request bears a valid hr_unlock cookie. Always True when
    the gate is disabled (HR_UNLOCK_PASSWORD unset)."""
    if not hr_gate_enabled():
        return True
    token = _parse_cookies(handler).get('hr_unlock', '')
    if not token:
        return False
    with _hr_tokens_lock:
        return token in _hr_tokens


def is_hr_record(sys_id: str) -> bool:
    """Whether a sys_id refers to an incident assigned to the HR group.
    Only checks `incident` — that's the table the gate covers."""
    if not hr_gate_enabled():
        return False
    conn = get_conn()
    row = conn.execute(
        'SELECT 1 FROM incident WHERE sys_id = ? AND assignment_group = ? LIMIT 1',
        (sys_id, HR_GROUP_SYS_ID),
    ).fetchone()
    return row is not None


def hr_subquery() -> str:
    """SQL fragment that selects sys_ids of HR-restricted incidents — for use
    in `WHERE element_id NOT IN (...)` style filters."""
    return '(SELECT sys_id FROM incident WHERE assignment_group = ?)'


# Tables whose rows are tied to a parent incident's sys_id via the listed
# column. When the HR gate is locked, rows referencing an HR-assigned
# incident must be hidden from the generic /api/<table> list route and
# /api/<table>/<sys_id> record route — otherwise a caller can pull HR
# journal entries, audit trails, attachment metadata, etc. by querying the
# child table directly with `?element_id=<hr_incident_sys_id>` or just
# dumping the whole table.
HR_PARENT_COLUMN = {
    'sys_journal_field': 'element_id',
    'sys_audit':         'documentkey',
    'sys_attachment':    'table_sys_id',
    'sys_email':         'instance',
    'task_ci':           'task',
    'task_sla':          'task',
    'incident_task':     'parent',
}


def _hr_record_parent_locked(table: str, sys_id: str) -> bool:
    """True iff `table` is HR-gated by a parent column AND the row at `sys_id`
    points at an HR-assigned incident. Used by get_record to block direct
    fetches of e.g. a sys_journal_field row whose element_id is an HR
    incident."""
    col = HR_PARENT_COLUMN.get(table)
    if not col or not hr_gate_enabled():
        return False
    conn = get_conn()
    row = conn.execute(
        f'SELECT 1 FROM "{table}" t JOIN incident i ON i.sys_id = t."{col}" '
        f'WHERE t.sys_id = ? AND i.assignment_group = ? LIMIT 1',
        (sys_id, HR_GROUP_SYS_ID),
    ).fetchone()
    return row is not None


def _attachment_is_hr(attach_sys_id: str) -> bool:
    """True if this sys_attachment row is linked to an HR-assigned incident.
    Used to gate the static /data/attachments/<...> route — without this,
    knowing an attachment's sys_id is enough to download HR file bodies."""
    if not hr_gate_enabled():
        return False
    conn = get_conn()
    row = conn.execute(
        'SELECT 1 FROM sys_attachment a JOIN incident i ON i.sys_id = a.table_sys_id '
        'WHERE a.sys_id = ? AND i.assignment_group = ? LIMIT 1',
        (attach_sys_id, HR_GROUP_SYS_ID),
    ).fetchone()
    return row is not None


def _row_to_dict(row):
    """Convert a sqlite3.Row to a dict, parsing the `raw` JSON envelope into the
    main payload so the viewer sees a single flat object."""
    d = dict(row)
    raw = d.pop('raw', None)
    if raw:
        try:
            envelope = json.loads(raw)
            # Merge envelope on top of indexed columns so envelope (full data)
            # wins. Envelope has the {value, display_value} structure the
            # viewer's flatten() expects.
            envelope.update({k: v for k, v in d.items() if k not in envelope})
            return envelope
        except json.JSONDecodeError:
            pass
    return d


# --- query handlers -------------------------------------------------------

def list_table(handler, table, params):
    """GET /api/<table>?limit=&offset=&q=&<field>=<value>&order_by=&dir=&slim=1
    Returns {rows: [...], total: <int>, limit, offset}.

    slim=1: return only indexed columns (sys_id + extracted fields), skip the
    raw envelope. Use for eager-loading list views that only need lookups."""
    if table not in ALL_TABLES:
        return _send_error(handler, HTTPStatus.NOT_FOUND, f'unknown table: {table}')

    limit = min(int(params.get('limit', ['200'])[0] or '200'), 2_000_000)
    offset = int(params.get('offset', ['0'])[0] or '0')
    q = (params.get('q', [''])[0] or '').strip()
    # Default ordering is by sys_id (PK index = fast). The viewer should pass
    # ?order_by=sys_updated_on for views that need recent-first; not every
    # table has sys_updated_on indexed (cmdb_ci doesn't, e.g.).
    order_by_param = params.get('order_by', [None])[0]
    direction = (params.get('dir', ['desc'])[0] or 'desc').lower()
    if direction not in ('asc', 'desc'):
        direction = 'desc'
    slim = (params.get('slim', ['0'])[0] or '0').lower() in ('1', 'true', 'yes')

    # Whitelist order_by to actual columns to prevent SQL injection.
    conn = get_conn()
    if not _table_exists(conn, table):
        # Allowed but not yet built into the DB (see _table_exists) — return an
        # empty page instead of 500-ing on every caller during the rollout
        # window before the next export/build loads the table.
        return _json_response(handler, {'rows': [], 'total': 0, 'limit': limit, 'offset': offset})
    cols = [r['name'] for r in conn.execute(f'PRAGMA table_info("{table}")')]
    order_by = order_by_param if (order_by_param in cols) else 'sys_id'

    select_cols = '*' if not slim else ', '.join(f'"{c}"' for c in cols if c != 'raw')

    where = []
    args = []
    # Free-text search on number/short_description if present
    if q:
        like = f'%{q}%'
        text_cols = [c for c in ('number', 'short_description', 'name', 'value',
                                 'ip_address', 'fqdn') if c in cols]
        if text_cols:
            where.append('(' + ' OR '.join(f'"{c}" LIKE ?' for c in text_cols) + ')')
            args.extend([like] * len(text_cols))
    # Exact-match field filters: any other ?key=value treated as col=value.
    # Many boolean-shaped columns are extracted as 1/0 by build_sqlite (the
    # `1 if str(_v(r.get('active'))) ... == 'true' else 0` pattern) but the
    # UI carries them around as the ServiceNow display value 'true'/'false'.
    # Coerce so `?active=true` matches stored 1 — otherwise toggles like
    # "active only" silently return zero rows across every list page.
    RESERVED = {'limit', 'offset', 'q', 'order_by', 'dir', 'slim'}
    BOOL_COERCE = {'true': '1', 'false': '0'}
    # Range filters: ?<col>_before=X / ?<col>_after=X compare an indexed column
    # with </>= instead of equality. Drives the CI list's staleness filter
    # (last_discovered_before=<cutoff>). Only applied when <col> is an actual
    # indexed column and the value is non-empty, so on a DB built before the
    # column existed the param is a harmless no-op (filter feature-detected off
    # in the UI). A '_before' bound also excludes empty strings — "no date" is
    # not "an early date", so an un-discovered CI shouldn't match "before X".
    RANGE_OPS = (('_before', '<'), ('_after', '>='))
    for k, vs in params.items():
        if k in RESERVED:
            continue
        val = vs[0] if vs else ''
        is_range = False
        for suf, op in RANGE_OPS:
            if k.endswith(suf):
                is_range = True
                base = k[:-len(suf)]
                if base in cols and val:
                    where.append(f'"{base}" {op} ?')
                    args.append(val)
                    if op == '<':
                        where.append(f'"{base}" != ?')
                        args.append('')
                break
        if is_range or k not in cols:
            continue
        # Comma-separated value → IN(...). Lets a single filter option match
        # several coded values that share a display label (the CMDB metrics
        # merges e.g. multiple 'Retired' install_status codes into one option
        # whose value is "7,3"). Our indexed filter values are codes/sys_ids/
        # source names — none contain commas — so this only fires for those
        # multi-code options.
        if ',' in val:
            parts = [BOOL_COERCE.get(x.lower(), x) for x in val.split(',') if x != '']
            if not parts:
                continue
            where.append(f'"{k}" IN ({",".join("?" * len(parts))})')
            args.extend(parts)
        else:
            where.append(f'"{k}" = ?')
            args.append(BOOL_COERCE.get(val.lower(), val))

    # HR gate. Two shapes:
    #   incident itself      → filter on its own assignment_group.
    #   child / join tables  → filter on their parent-incident reference
    #                          (see HR_PARENT_COLUMN). Without this, callers
    #                          can pull HR journal/audit/attachment rows by
    #                          querying the child table directly.
    if not is_hr_unlocked(handler):
        if table == 'incident':
            where.append('"assignment_group" IS NOT ?')
            args.append(HR_GROUP_SYS_ID)
        elif table in HR_PARENT_COLUMN:
            col = HR_PARENT_COLUMN[table]
            where.append(f'"{col}" NOT IN {hr_subquery()}')
            args.append(HR_GROUP_SYS_ID)

    where_sql = ('WHERE ' + ' AND '.join(where)) if where else ''
    total = conn.execute(f'SELECT COUNT(*) AS n FROM "{table}" {where_sql}', args).fetchone()['n']
    rows = conn.execute(
        f'SELECT {select_cols} FROM "{table}" {where_sql} ORDER BY "{order_by}" {direction.upper()} '
        f'LIMIT ? OFFSET ?', args + [limit, offset]
    ).fetchall()

    if slim:
        # Indexed cols are already flat scalars — no envelope to merge.
        out_rows = [{k: r[k] for k in r.keys()} for r in rows]
    else:
        out_rows = [_row_to_dict(r) for r in rows]

    cache = 300 if (table in CACHE_5MIN and not q and limit > 200) else 0
    _json_response(handler, {
        'rows': out_rows,
        'total': total, 'limit': limit, 'offset': offset,
    }, cache_seconds=cache)


def get_record(handler, table, sys_id):
    if table not in ALL_TABLES:
        return _send_error(handler, HTTPStatus.NOT_FOUND, f'unknown table: {table}')
    if not is_hr_unlocked(handler):
        if table == 'incident' and is_hr_record(sys_id):
            return _send_error(handler, HTTPStatus.FORBIDDEN, 'hr_locked')
        if table in HR_PARENT_COLUMN and _hr_record_parent_locked(table, sys_id):
            return _send_error(handler, HTTPStatus.FORBIDDEN, 'hr_locked')
    conn = get_conn()
    if not _table_exists(conn, table):
        # Allowed table not yet built into the DB (see _table_exists) — no
        # record can exist, so 404 rather than 500 on "no such table".
        return _send_error(handler, HTTPStatus.NOT_FOUND, f'{table}/{sys_id} not in archive')
    row = conn.execute(f'SELECT * FROM "{table}" WHERE sys_id = ?', (sys_id,)).fetchone()
    if not row:
        return _send_error(handler, HTTPStatus.NOT_FOUND, f'{table}/{sys_id} not in archive')
    _json_response(handler, _row_to_dict(row))


def get_sla_stats(handler, kind, sys_id):
    """SLA performance for a user's or group's incidents. Joins task_sla to
    incident on task=sys_id (incidents are the primary SLA-bearing table),
    counting breaches (has_breached lives in the raw envelope, read via
    json_extract) and grouping by stage. HR-gated: HR-assigned incidents are
    excluded when the gate is locked, matching the incident list route.
    Returns {total, breached, by_stage:{stage:count}}."""
    col = 'assigned_to' if kind == 'user' else 'assignment_group'
    conn = get_conn()
    empty = {'total': 0, 'breached': 0, 'by_stage': {}}
    if not _table_exists(conn, 'task_sla') or not _table_exists(conn, 'incident'):
        return _json_response(handler, empty)
    where = [f'i."{col}" = ?']
    args = [sys_id]
    if not is_hr_unlocked(handler):
        # IS NOT (not !=) so incidents with a NULL assignment_group aren't
        # dropped — `NULL != ?` is unknown and would fail the WHERE.
        where.append('i.assignment_group IS NOT ?')
        args.append(HR_GROUP_SYS_ID)
    try:
        rows = conn.execute(
            f'''SELECT ts.stage AS stage, COUNT(*) AS n,
                       SUM(CASE WHEN lower(json_extract(ts.raw, '$.has_breached.value')) IN ('true', '1')
                                THEN 1 ELSE 0 END) AS breached
                FROM task_sla ts JOIN incident i ON i.sys_id = ts.task
                WHERE {' AND '.join(where)}
                GROUP BY ts.stage''',
            args,
        ).fetchall()
    except sqlite3.OperationalError:
        return _json_response(handler, empty)
    total = sum(r['n'] for r in rows)
    breached = sum((r['breached'] or 0) for r in rows)
    by_stage = {(r['stage'] or 'unknown'): r['n'] for r in rows}
    _json_response(handler, {'total': total, 'breached': breached, 'by_stage': by_stage})


def get_journal_for(handler, element_id):
    if not is_hr_unlocked(handler) and is_hr_record(element_id):
        return _send_error(handler, HTTPStatus.FORBIDDEN, 'hr_locked')
    conn = get_conn()
    rows = conn.execute(
        'SELECT * FROM sys_journal_field WHERE element_id = ? ORDER BY sys_created_on ASC',
        (element_id,)
    ).fetchall()
    _json_response(handler, {'rows': [_row_to_dict(r) for r in rows]})


def get_audit_for(handler, documentkey):
    if not is_hr_unlocked(handler) and is_hr_record(documentkey):
        return _send_error(handler, HTTPStatus.FORBIDDEN, 'hr_locked')
    conn = get_conn()
    rows = conn.execute(
        'SELECT * FROM sys_audit WHERE documentkey = ? ORDER BY sys_created_on ASC',
        (documentkey,)
    ).fetchall()
    _json_response(handler, {'rows': [_row_to_dict(r) for r in rows]})


def get_attachments_for(handler, table_sys_id):
    if not is_hr_unlocked(handler) and is_hr_record(table_sys_id):
        return _send_error(handler, HTTPStatus.FORBIDDEN, 'hr_locked')
    conn = get_conn()
    rows = conn.execute(
        'SELECT * FROM sys_attachment WHERE table_sys_id = ? ORDER BY sys_created_on ASC',
        (table_sys_id,)
    ).fetchall()
    _json_response(handler, {'rows': [_row_to_dict(r) for r in rows]})


def get_variables_for(handler, ritm_sys_id):
    """Return the catalog variables a user submitted on an RITM.

    Joins sc_item_option_mtom (link table) → sc_item_option (value) →
    item_option_new (def: label, type, reference target). The shape is
    consistent across catalog items even though every form has a
    different set of fields, since item_option_new carries the schema."""
    if not is_hr_unlocked(handler) and is_hr_record(ritm_sys_id):
        return _send_error(handler, HTTPStatus.FORBIDDEN, 'hr_locked')
    conn = get_conn()
    rows = conn.execute(
        '''SELECT
              o.sys_id          AS opt_sys_id,
              o.value           AS value,
              d.sys_id          AS def_sys_id,
              d.name            AS var_name,
              d.question_text   AS label,
              d.type            AS type,
              d."order"         AS order_idx,
              d.reference       AS reference,
              c.name            AS cat_item_name
            FROM sc_item_option_mtom m
            LEFT JOIN sc_item_option   o ON o.sys_id = m.sc_item_option
            LEFT JOIN item_option_new  d ON d.sys_id = o.item_option_new
            LEFT JOIN sc_cat_item      c ON c.sys_id = o.cat_item
            WHERE m.request_item = ?
            ORDER BY CAST(NULLIF(d."order", "") AS INTEGER), d.question_text''',
        (ritm_sys_id,),
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        # Skip rows where the variable definition is missing — the link
        # table can have orphans pointing at definitions that were deleted.
        if not d.get('label') and not d.get('var_name'):
            continue
        out.append(d)
    _json_response(handler, {'rows': out, 'cat_item': out[0]['cat_item_name'] if out else None})


# Base64+gzip blob fields Flow Designer stores its configured data in (action
# inputs, trigger config, logic inputs, compiled snapshots). Decoding them
# turns the archived flow internals into readable structure.
_FLOW_BLOB_FIELDS = frozenset({
    'values', 'trigger_inputs', 'inputs', 'extended_inputs',
    'workflow_inputs', 'action_inputs', 'decision_table_inputs', 'outputs',
})


def _decode_flow_blob(s):
    """Decode a Flow Designer field: base64+gzip JSON, else plain JSON, else the
    string unchanged."""
    if not isinstance(s, str) or not s:
        return s
    try:
        return json.loads(gzip.decompress(base64.b64decode(s)).decode('utf-8'))
    except Exception:                                            # noqa: BLE001
        pass
    try:
        return json.loads(s)
    except Exception:                                            # noqa: BLE001
        return s


def _flow_record_raw(raw_str):
    """Unwrap an archived flow record to its real stored values (the `value`
    side of each envelope) and decode the encoded blob fields in place, so the
    result is the actual ServiceNow data, usable."""
    try:
        env = json.loads(raw_str)
    except Exception:                                            # noqa: BLE001
        return {}
    out = {}
    for k, v in env.items():
        if isinstance(v, dict):
            val, disp = v.get('value'), v.get('display_value')
        else:
            val, disp = v, None
        if k in _FLOW_BLOB_FIELDS or k == 'label_cache':
            out[k] = _decode_flow_blob(val)
        elif disp not in (None, '', val):
            # reference field — keep both the stored sys_id and its resolved
            # name so the raw data is still legible.
            out[k] = {'value': val, 'display': disp}
        else:
            out[k] = val
    return out


def _flow_order_key(rec):
    s = str(rec.get('order') or '0').split('➛')[0].split('-')[0]
    digits = ''.join(ch for ch in s if ch.isdigit())
    return int(digits) if digits else 0


def get_flow_reconstruction(handler, flow_id):
    """Raw ServiceNow source data for a flow — the actual records behind it
    (header, triggers, action steps, flow-logic blocks) with the base64+gzip
    config blobs decoded. The unprocessed, multi-table data used to reverse-
    engineer how a flow works."""
    conn = get_conn()

    def _exists(table):
        return conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            (table,)).fetchone() is not None

    def _by_flow(table):
        if not _exists(table):
            return []
        rows = conn.execute('SELECT raw FROM "%s" WHERE flow = ?' % table,
                            (flow_id,)).fetchall()
        recs = [_flow_record_raw(r[0]) for r in rows if r[0]]
        recs.sort(key=_flow_order_key)
        return recs

    flow = None
    if _exists('sys_hub_flow'):
        r = conn.execute('SELECT raw FROM sys_hub_flow WHERE sys_id = ?',
                         (flow_id,)).fetchone()
        if r and r[0]:
            flow = _flow_record_raw(r[0])

    actions = _by_flow('sys_hub_action_instance_v2') + _by_flow('sys_hub_action_instance')
    triggers = _by_flow('sys_hub_trigger_instance') + _by_flow('sys_hub_trigger_instance_v2')
    logic = _by_flow('sys_hub_flow_logic')

    if flow is None and not (actions or triggers or logic):
        return _send_error(handler, HTTPStatus.NOT_FOUND, 'flow not in snapshot')

    _json_response(handler, {
        'flow': flow, 'triggers': triggers, 'actions': actions, 'logic': logic,
        'counts': {'actions': len(actions), 'triggers': len(triggers), 'logic': len(logic)},
    }, cache_seconds=300)


def get_ci_relations(handler, sys_id):
    conn = get_conn()
    upstream = conn.execute(
        'SELECT r.*, c.raw AS ci_raw FROM cmdb_rel_ci r '
        'LEFT JOIN cmdb_ci c ON c.sys_id = r.parent '
        'WHERE r.child = ?',
        (sys_id,)
    ).fetchall()
    downstream = conn.execute(
        'SELECT r.*, c.raw AS ci_raw FROM cmdb_rel_ci r '
        'LEFT JOIN cmdb_ci c ON c.sys_id = r.child '
        'WHERE r.parent = ?',
        (sys_id,)
    ).fetchall()
    def _expand(rows):
        out = []
        for r in rows:
            d = _row_to_dict(r)
            ci_raw = d.pop('ci_raw', None)
            if ci_raw:
                try:
                    d['ci'] = json.loads(ci_raw)
                except json.JSONDecodeError:
                    pass
            out.append(d)
        return out
    _json_response(handler, {
        'upstream': _expand(upstream),
        'downstream': _expand(downstream),
    })


def cross_table_search(handler, params):
    """GET /api/search?q=&types=incident,change_request,problem,…&limit=
    Searches `number` and `short_description` across the listed task tables."""
    q = (params.get('q', [''])[0] or '').strip()
    if not q:
        return _json_response(handler, {'rows': []})
    types_param = (params.get('types', [''])[0] or '').strip()
    types = [t for t in (types_param.split(',') if types_param else list(TASK_TABLES))
             if t in TASK_TABLES]
    limit_per_table = max(1, min(int(params.get('limit', ['8'])[0] or '8'), 50))

    like = f'%{q}%'
    hr_unlocked = is_hr_unlocked(handler)
    out = []
    conn = get_conn()
    for t in types:
        sql = (f'SELECT sys_id, number, short_description, state, priority, '
               f'sys_updated_on, raw FROM "{t}" '
               f'WHERE (number LIKE ? OR short_description LIKE ?)')
        args = [like, like]
        if not hr_unlocked:
            if t == 'incident':
                sql += ' AND assignment_group IS NOT ?'
                args.append(HR_GROUP_SYS_ID)
            elif t in HR_PARENT_COLUMN:
                # incident_task etc. — hide rows whose parent incident is HR.
                col = HR_PARENT_COLUMN[t]
                sql += f' AND "{col}" NOT IN {hr_subquery()}'
                args.append(HR_GROUP_SYS_ID)
        sql += ' ORDER BY sys_updated_on DESC LIMIT ?'
        args.append(limit_per_table)
        try:
            rows = conn.execute(sql, args).fetchall()
        except sqlite3.Error:
            continue
        for r in rows:
            d = _row_to_dict(r)
            d['_table'] = t
            out.append(d)
    _json_response(handler, {'rows': out, 'q': q})


def _build_manifest_payload():
    p = DATA_DIR / 'manifest.json'
    return json.loads(p.read_text(encoding='utf-8')) if p.is_file() else {}


def _build_cmdb_ci_lookup_payload():
    conn = get_conn()
    rows = conn.execute(
        'SELECT sys_id, name, sys_class_name, operational_status FROM cmdb_ci'
    ).fetchall()
    out = {}
    for r in rows:
        out[r['sys_id']] = {
            'name': r['name'],
            'sys_class_name': r['sys_class_name'],
            'operational_status': r['operational_status'],
        }
    return out


# --- CMDB metrics --------------------------------------------------------
# Precomputed aggregates for the CMDB overview page and the CI-list filter
# dropdowns. Same cache contract as the lookup payloads (keyed on db mtime,
# warmed at startup), because for a frozen archive the numbers never change
# between builds — computing them once per DB and serving a memcpy beats a
# fan-out of GROUP BYs on every page load.
#
# Performance: a dimension is computed ONLY when its column is indexed, so
# every aggregate is an indexed GROUP BY / COUNT. We do NOT fall back to
# json_extract over `raw` for un-indexed columns — on a multi-million-row
# cmdb_ci that's a per-row JSON parse for the whole table (measured at ~9 min
# for the full payload), which is unusable for a request and, worse, starved
# the shared lookup cache. So pre-CMDB_INDEXED_COLS-expansion the payload
# carries the dimensions that ARE indexed (class, operational_status, owned_by)
# plus relationship coverage; install/discovery/staleness/support_group appear
# only once their columns are indexed. `indexed_columns` tells the viewer which
# dimensions exist so it can feature-detect both the filters and the panels.

def _cmdb_columns(conn):
    try:
        return {r['name'] for r in conn.execute('PRAGMA table_info("cmdb_ci")')}
    except sqlite3.Error:
        return set()


def _cmdb_dist(conn, field, has_col, label_field=True):
    """Distribution of cmdb_ci over `field` as [{value,label,count}] desc.

    Requires `field` to be an indexed column — returns [] otherwise. Grouping
    by the indexed column keeps the GROUP BY index-backed; the display label is
    read from the {value, display_value} envelope as a *bare* (non-aggregated)
    column, which SQLite evaluates once per group (≈ a few hundred json_extract
    calls), NOT once per row. Grouping by json_extract instead would force a
    per-row JSON parse of the whole table, which is the slow path we avoid."""
    if not has_col:
        return []
    lbl = f"json_extract(raw,'$.{field}.display_value')" if label_field else f'"{field}"'
    sql = (f'SELECT "{field}" AS v, {lbl} AS l, COUNT(*) AS n '
           f'FROM cmdb_ci GROUP BY "{field}" ORDER BY n DESC')
    # Collapse entries that render to the same label — ServiceNow can ship more
    # than one coded value for a single status label (e.g. multiple 'Retired'
    # install_status codes). Rows arrive count-desc. The merged option carries
    # ALL underlying coded values as a comma-joined `value`, so a click-through
    # filter sends ?col=a,b and list_table expands it to IN(...). Without that,
    # the dropdown count (sum across codes) wouldn't match the filtered list
    # (a single code).
    merged = {}
    for r in conn.execute(sql):
        v = r['v'] if r['v'] is not None else ''
        label = r['l'] or v or '(empty)'
        if label in merged:
            merged[label]['count'] += r['n']
            if v:
                merged[label]['_vals'].append(v)
        else:
            merged[label] = {'value': v, 'label': label, 'count': r['n'],
                             '_vals': [v] if v else []}
    out = []
    for o in sorted(merged.values(), key=lambda o: -o['count']):
        vals = o.pop('_vals')
        if len(vals) > 1:
            o['value'] = ','.join(vals)
        out.append(o)
    return out


def _cmdb_staleness(conn, has_col, snapshot_date):
    """Bucket CIs by how long before the snapshot they were last_discovered.
    last_discovered is 'YYYY-MM-DD HH:MM:SS' which sorts chronologically, so
    string compares against pre-computed cutoffs beat per-row julianday().
    Requires the indexed column (returns [] otherwise) — bucketing over
    json_extract would parse JSON for every row."""
    if not has_col:
        return []
    try:
        ref = datetime.datetime.strptime((snapshot_date or '')[:10], '%Y-%m-%d')
    except ValueError:
        return []
    fmt = lambda d: (ref - datetime.timedelta(days=d)).strftime('%Y-%m-%d %H:%M:%S')
    c7, c30, c90, c365 = fmt(7), fmt(30), fmt(90), fmt(365)
    ld = '"last_discovered"'
    sql = (f"SELECT CASE "
           f"WHEN {ld} IS NULL OR {ld}='' THEN 'never' "
           f"WHEN {ld} >= ? THEN '0-7d' "
           f"WHEN {ld} >= ? THEN '8-30d' "
           f"WHEN {ld} >= ? THEN '31-90d' "
           f"WHEN {ld} >= ? THEN '91-365d' "
           f"ELSE '365d+' END AS bucket, COUNT(*) AS n "
           f"FROM cmdb_ci GROUP BY bucket")
    counts = {r['bucket']: r['n'] for r in conn.execute(sql, (c7, c30, c90, c365))}
    order = ['0-7d', '8-30d', '31-90d', '91-365d', '365d+', 'never']
    return [{'bucket': b, 'count': counts.get(b, 0)} for b in order if counts.get(b)]


def _cmdb_nonempty(conn, field, has_col):
    """Count of CIs with a non-empty `field`. Indexed columns only — returns
    None (omitted from the payload) otherwise, since a json_extract scan over
    the whole table is the slow path we avoid."""
    if not has_col:
        return None
    return conn.execute(
        f'SELECT COUNT(*) AS n FROM cmdb_ci WHERE "{field}" IS NOT NULL AND "{field}" != \'\''
    ).fetchone()['n']


def _cmdb_relationships(conn, total):
    """Relationship-type distribution (indexed GROUP BY) + connected/orphan CI
    coverage. `connected` = distinct CIs that appear as a parent or child AND
    exist in this cmdb_ci snapshot: a UNION over the indexed parent/child
    columns, joined back to cmdb_ci on sys_id. The join matters — cmdb_rel_ci
    can carry a dangling endpoint (a sys_id no longer in the snapshot), and
    counting it would overstate `connected` (possibly past `total`) and zero
    out `orphans`. Still far cheaper than probing every cmdb_ci row with
    sys_id IN (…): we probe only the ~distinct endpoints against the PK. Guarded
    so a failure degrades to 'no rel data' rather than sinking the build."""
    out = {}
    try:
        out['types'] = [
            {'label': (r['type'] or '(empty)'), 'count': r['n']}
            for r in conn.execute(
                'SELECT type, COUNT(*) AS n FROM cmdb_rel_ci GROUP BY type ORDER BY n DESC')
        ]
        out['total_rels'] = conn.execute('SELECT COUNT(*) AS n FROM cmdb_rel_ci').fetchone()['n']
        connected = conn.execute(
            'SELECT COUNT(*) AS n FROM ('
            "  SELECT parent AS s FROM cmdb_rel_ci WHERE parent IS NOT NULL AND parent <> ''"
            '  UNION'
            "  SELECT child  AS s FROM cmdb_rel_ci WHERE child  IS NOT NULL AND child  <> ''"
            ') u JOIN cmdb_ci c ON c.sys_id = u.s'
        ).fetchone()['n']
        out['connected'] = connected
        out['orphans'] = max(0, total - connected)
    except sqlite3.Error as e:
        out['error'] = str(e)[:120]
    return out


def _build_cmdb_metrics_payload():
    conn = get_conn()
    cols = _cmdb_columns(conn)
    total = conn.execute('SELECT COUNT(*) AS n FROM cmdb_ci').fetchone()['n']
    snap = _build_manifest_payload()
    snapshot_date = snap.get('snapshot_date') or (snap.get('captured_at') or '')[:10]
    return {
        'total': total,
        'snapshot_date': snapshot_date,
        # which dimensions are filterable server-side (indexed) — UI feature-detects
        'indexed_columns': sorted(cols),
        'classes': _cmdb_dist(conn, 'sys_class_name', 'sys_class_name' in cols),
        'operational_status': _cmdb_dist(conn, 'operational_status', 'operational_status' in cols),
        'install_status': _cmdb_dist(conn, 'install_status', 'install_status' in cols),
        'discovery_source': _cmdb_dist(conn, 'discovery_source', 'discovery_source' in cols),
        'staleness': _cmdb_staleness(conn, 'last_discovered' in cols, snapshot_date),
        'ownership': {
            'owned_by': _cmdb_nonempty(conn, 'owned_by', 'owned_by' in cols),
            'support_group': _cmdb_nonempty(conn, 'support_group', 'support_group' in cols),
            'total': total,
        },
        'relationships': _cmdb_relationships(conn, total),
    }


def _build_sys_user_lookup_payload():
    conn = get_conn()
    rows = conn.execute(
        'SELECT sys_id, name, user_name, title, department, location FROM sys_user'
    ).fetchall()
    out = {}
    for r in rows:
        out[r['sys_id']] = {
            'name': r['name'],
            'user_name': r['user_name'],
            'title': r['title'],
            'department': r['department'],
            'location': r['location'],
        }
    return out


def get_manifest(handler):
    if not (DATA_DIR / 'manifest.json').is_file():
        return _send_error(handler, HTTPStatus.NOT_FOUND, 'manifest.json missing')
    _serve_cached_lookup(handler, 'manifest', _build_manifest_payload)


def get_cmdb_ci_lookup(handler):
    """Compact CI lookup table — served from in-memory cache so first
    request is O(network), not O(1M-row scan + json + gzip)."""
    _serve_cached_lookup(handler, 'cmdb_ci_lookup', _build_cmdb_ci_lookup_payload)


def get_cmdb_metrics(handler):
    """CMDB overview aggregates (class/status/discovery/staleness/ownership/
    relationships) — cached in memory keyed on db mtime. Shorter browser
    max-age than the lookups: this payload carries `indexed_columns`, which
    changes on a column-only rebuild that leaves the source snapshot (and thus
    the lookup cache key) untouched, so we want clients to revalidate sooner
    and pick up newly-filterable dimensions. The ETag still 304s the common
    no-change case."""
    _serve_cached_lookup(handler, 'cmdb_metrics', _build_cmdb_metrics_payload, max_age=600)


def get_hr_status(handler):
    _json_response(handler, {
        'enabled': hr_gate_enabled(),
        'unlocked': is_hr_unlocked(handler),
        'group_sys_id': HR_GROUP_SYS_ID,
        'group_label': HR_GROUP_LABEL,
    })


def get_whoami(handler):
    """Return what the server sees about the caller. There is no auth in
    front of this service — this is identity-by-network-position, not
    identity-by-credential. The viewer renders these values so a caller
    can verify what gets logged about them."""
    ip = _client_ip(handler)
    host = _reverse_dns(ip)
    _json_response(handler, {
        'ip': ip if ip != '-' else None,
        'host': host if host != '-' else None,
        'access_log': bool(ACCESS_LOG_PATH),
    })


def post_hr_unlock(handler, body):
    if not hr_gate_enabled():
        return _send_error(handler, HTTPStatus.SERVICE_UNAVAILABLE,
                           'gate disabled (HR_UNLOCK_PASSWORD unset)')
    try:
        payload = json.loads(body or b'{}')
    except json.JSONDecodeError:
        return _send_error(handler, HTTPStatus.BAD_REQUEST, 'invalid JSON')
    pw = (payload.get('password') or '').encode('utf-8')
    expected = HR_UNLOCK_PASSWORD.encode('utf-8')
    # Constant-time compare; supplied password might be empty.
    if not pw or not hmac.compare_digest(pw, expected):
        return _send_error(handler, HTTPStatus.FORBIDDEN, 'wrong password')
    token = secrets.token_hex(16)
    with _hr_tokens_lock:
        _hr_tokens.add(token)
    body_bytes = json.dumps({'ok': True}).encode('utf-8')
    handler.send_response(HTTPStatus.OK)
    handler.send_header('Content-Type', 'application/json; charset=utf-8')
    handler.send_header('Content-Length', str(len(body_bytes)))
    handler.send_header('Cache-Control', 'no-store')
    handler.send_header('Set-Cookie',
                        f'hr_unlock={token}; Path=/; HttpOnly; SameSite=Strict')
    handler.end_headers()
    handler.wfile.write(body_bytes)


def post_hr_lock(handler):
    token = _parse_cookies(handler).get('hr_unlock', '')
    if token:
        with _hr_tokens_lock:
            _hr_tokens.discard(token)
    body_bytes = json.dumps({'ok': True}).encode('utf-8')
    handler.send_response(HTTPStatus.OK)
    handler.send_header('Content-Type', 'application/json; charset=utf-8')
    handler.send_header('Content-Length', str(len(body_bytes)))
    handler.send_header('Cache-Control', 'no-store')
    handler.send_header('Set-Cookie',
                        'hr_unlock=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0')
    handler.end_headers()
    handler.wfile.write(body_bytes)


def get_sys_user_lookup(handler):
    """Compact user lookup table — served from in-memory cache (140k rows)."""
    _serve_cached_lookup(handler, 'sys_user_lookup', _build_sys_user_lookup_payload)


# Tables whose contents change rarely between exports — safe to cache for
# a few minutes in the browser. Sys_audit/journal/attachments still hit
# /api/<table>/<sys_id> per record, those stay no-cache.
CACHE_5MIN = {
    'sys_choice', 'core_company', 'cmn_department', 'cmn_location',
    'cmn_cost_center', 'sys_user', 'sys_user_group', 'sys_user_grmember',
    'change_request', 'problem', 'problem_task',
    'sc_request', 'sc_req_item', 'sc_task',
    'incident_task', 'change_task',
    'sysapproval_group', 'asset_task',
    'sn_contract_renewal_task', 'sn_ent_facility_asset',
    'task_ci', 'task_sla', 'sysapproval_approver',
    # Catalog admin metadata is small and changes rarely — fine to cache.
    'sc_cat_item', 'sc_catalog', 'sc_category',
    'catalog_ui_policy', 'catalog_ui_policy_action',
    'catalog_script_client',
    'user_criteria',
    'sc_cat_item_user_criteria_mtom', 'sc_cat_item_user_criteria_no_mtom',
    'item_option_new_set', 'io_set_item', 'topic',
    'std_change_proposal',
    'item_option_new', 'question', 'question_choice',
    # Server-side logic. Rules + scripts + policies — definitions change
    # rarely (much rarer than transactional task rows) so a 5-minute cache
    # is safe even for the bigger tables here (sys_script ~7k rows).
    'sys_script', 'sys_script_client', 'sys_script_include',
    'sysauto_script',
    'sys_ui_policy', 'sys_ui_policy_action',
    'sys_data_policy2', 'sys_data_policy_rule',
    # Server-side context. sys_dictionary is ~300k rows but the per-table
    # inspector queries it filtered by name=<table>, so a 5-min cache on
    # the filtered response is fine; the unfiltered list-page is gated by
    # `not q and limit > 200` upstream so we won't cache full dumps.
    'sys_properties', 'sys_ui_action',
    'sys_dictionary', 'sys_dictionary_override',
    'sys_hub_flow',
    'flow_inventory',
    'sys_hub_action_instance_v2', 'sys_hub_action_instance',
    'sys_hub_trigger_instance', 'sys_hub_trigger_instance_v2',
    'sys_hub_flow_logic',
    'sys_security_acl',
}


# --- routing --------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = 'historicalwow/1'

    # Suppress the stdlib default per-request stderr line; we emit our own
    # structured record to the access log instead. The status code captured
    # here in log_request() comes from BaseHTTPRequestHandler.send_response,
    # which is called once per response.
    def log_message(self, fmt, *args):
        pass

    def log_request(self, code='-', size='-'):
        if isinstance(code, HTTPStatus):
            code = code.value
        self._access_status = code

    def _emit_access(self):
        if not ACCESS_LOG_PATH:
            return
        ua = self.headers.get('User-Agent', '-') or '-'
        # Drop healthcheck noise — Dockerfile pings `/` via wget every 30s
        # with this UA. Without this, ~95% of the log is /-200 selfchecks.
        if ua.startswith('Wget') and getattr(self, 'path', '') == '/':
            return
        ip = _client_ip(self)
        record = {
            'ts':     time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'ip':     ip,
            'host':   _reverse_dns(ip),
            'method': self.command or '-',
            'path':   getattr(self, 'path', '-'),
            'status': getattr(self, '_access_status', '-'),
            'ua':     ua[:160],
        }
        try:
            access_log.info(json.dumps(record, separators=(',', ':')))
        except Exception:
            # Never let logging break a real request.
            pass

    def do_GET(self):
        try:
            self._route()
        except (BrokenPipeError, ConnectionResetError):
            pass  # client disconnected
        except Exception as e:
            log.exception('handler crashed: %s', e)
            try:
                _send_error(self, HTTPStatus.INTERNAL_SERVER_ERROR, str(e))
            except Exception:
                pass
        finally:
            self._emit_access()

    def do_POST(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            length = int(self.headers.get('Content-Length', '0') or '0')
            body = self.rfile.read(length) if length > 0 else b''
            if path == '/api/hr-unlock':
                return post_hr_unlock(self, body)
            if path == '/api/hr-lock':
                return post_hr_lock(self)
            return _send_error(self, HTTPStatus.NOT_FOUND, f'no route: {path}')
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            log.exception('handler crashed: %s', e)
            try:
                _send_error(self, HTTPStatus.INTERNAL_SERVER_ERROR, str(e))
            except Exception:
                pass
        finally:
            self._emit_access()

    def _route(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        params = urllib.parse.parse_qs(parsed.query)

        # Static + special paths
        if path in ('/', '/HistoricalWow.html', '/index.html'):
            return _send_static(self, STATIC_HTML)

        # Compat: legacy data.js fetched data/manifest.json directly.
        if path == '/data/manifest.json':
            return get_manifest(self)

        # Attachment file bodies. URL shape: /data/attachments/<shard>/<attach_sys_id>/<filename>
        if path.startswith('/data/attachments/'):
            rel = path[len('/data/'):]
            parts = rel.split('/')
            # Reject path-traversal / empty segments before deriving any
            # value from the URL. Without this, a request like
            # /data/attachments/<x>/<x>/q/../../<hr_shard>/<hr_id>/<file>
            # would resolve via Path.resolve() to the HR file while the
            # HR-gate check below would read <x> as parts[2] and let it
            # through. Resolving first then re-deriving parts is an
            # alternative; rejecting traversal up front is simpler and
            # also blocks symlink-chasing attacks.
            if any(p in ('', '.', '..') for p in parts):
                return _send_error(self, HTTPStatus.FORBIDDEN, 'forbidden path')
            target = (DATA_DIR / rel).resolve()
            # Defense in depth: even with no traversal segments, confirm
            # the resolved path is under DATA_DIR.
            try:
                target.relative_to(DATA_DIR)
            except ValueError:
                return _send_error(self, HTTPStatus.FORBIDDEN, 'forbidden path')
            # HR gate. URL parts: [0]=attachments, [1]=shard, [2]=attach_sys_id.
            # Without this, anyone who knows an attachment's sys_id can
            # download HR file bodies — the metadata listing is gated but
            # the static path was open.
            if hr_gate_enabled() and not is_hr_unlocked(self):
                if len(parts) >= 3 and parts[0] == 'attachments':
                    attach_sys_id = parts[2]
                    if _attachment_is_hr(attach_sys_id):
                        return _send_error(self, HTTPStatus.FORBIDDEN, 'hr_locked')
            return _send_static(self, target)

        # Interactive docs and OpenAPI spec. Public — these routes sit in
        # front of the HR gate. The spec *describes* HR-gated endpoints but
        # holds no row data; try-it-out from /docs still goes through the
        # gate on every individual request.
        if path == '/docs':
            # 301 to /docs/ so the page's relative asset refs (./swagger-ui.css,
            # ./swagger-ui-bundle.js, etc.) resolve under /docs/ rather than /.
            # Without the trailing-slash redirect, the browser asks for
            # /swagger-ui.css and the asset route 404s, leaving the page
            # blank for anyone who typed the URL without the slash.
            self.send_response(HTTPStatus.MOVED_PERMANENTLY)
            self.send_header('Location', '/docs/')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        if path == '/docs/':
            return _send_static(self, APP_DIR / 'docs' / 'swagger-ui' / 'index.html')
        if path in ('/openapi.yaml', '/openapi-schemas.yaml'):
            return _send_static(self, APP_DIR / 'docs' / path.lstrip('/'),
                                content_type='application/yaml; charset=utf-8')
        m = re.match(r'^/docs/([\w.\-]+\.(?:css|js|png|ico|html|map))$', path)
        if m:
            asset = APP_DIR / 'docs' / 'swagger-ui' / m.group(1)
            # Defense in depth alongside the allow-listed extension regex —
            # same shape as the /data/attachments/ guard above.
            try:
                asset.resolve().relative_to((APP_DIR / 'docs' / 'swagger-ui').resolve())
            except ValueError:
                return _send_error(self, HTTPStatus.FORBIDDEN, 'forbidden path')
            return _send_static(self, asset)
        # Narrative + spec sources at /docs/<file>. The OpenAPI description
        # links to these with relative URLs ([API.md](API.md) etc.), which
        # Swagger UI resolves against the page's own /docs/ origin — so the
        # files must be reachable at /docs/<name>.<ext> for those links to
        # work.
        #
        # .md responses are content-negotiated:
        #   * Accept: text/html (browsers)  → serve md-viewer/viewer.html.
        #     The viewer's JS fetches the same URL back with
        #     Accept: text/markdown to get the raw bytes, then renders via
        #     marked.js.
        #   * Anything else (curl `*/*`, JS fetch with explicit
        #     text/markdown, scripted clients) → raw bytes, same as before.
        # .yaml files always serve raw — Swagger UI never opens them as
        # pages; they're only ever consumed by JS or CLI tooling.
        m = re.match(r'^/docs/([\w.\-]+\.(?:md|yaml))$', path)
        if m:
            asset = APP_DIR / 'docs' / m.group(1)
            try:
                asset.resolve().relative_to((APP_DIR / 'docs').resolve())
            except ValueError:
                return _send_error(self, HTTPStatus.FORBIDDEN, 'forbidden path')
            if asset.suffix == '.md':
                accept = self.headers.get('Accept', '') or ''
                # Both branches set Vary: Accept so caches keep the rendered-
                # viewer and raw-markdown representations on separate keys —
                # otherwise a cached curl response could be served to a
                # browser navigation (or vice versa).
                if 'text/html' in accept:
                    return _send_static(self,
                        APP_DIR / 'docs' / 'md-viewer' / 'viewer.html',
                        vary='Accept')
                return _send_static(self, asset,
                    content_type='text/markdown; charset=utf-8',
                    vary='Accept')
            return _send_static(self, asset,
                content_type='application/yaml; charset=utf-8')
        # md-viewer vendored assets (marked.js). Same defense-in-depth
        # shape as the /docs/<asset> swagger-ui route above.
        m = re.match(r'^/docs/md-viewer/([\w.\-]+\.(?:css|js|html))$', path)
        if m:
            asset = APP_DIR / 'docs' / 'md-viewer' / m.group(1)
            try:
                asset.resolve().relative_to((APP_DIR / 'docs' / 'md-viewer').resolve())
            except ValueError:
                return _send_error(self, HTTPStatus.FORBIDDEN, 'forbidden path')
            return _send_static(self, asset)

        # API
        if path == '/api/manifest':
            return get_manifest(self)
        if path == '/api/cmdb_ci_lookup':
            return get_cmdb_ci_lookup(self)
        if path == '/api/cmdb/metrics':
            return get_cmdb_metrics(self)
        if path == '/api/sys_user_lookup':
            return get_sys_user_lookup(self)
        if path == '/api/hr-status':
            return get_hr_status(self)
        if path == '/api/whoami':
            return get_whoami(self)
        if path == '/api/search':
            return cross_table_search(self, params)

        m = re.match(r'^/api/journal/([^/]+)$', path)
        if m:
            return get_journal_for(self, m.group(1))
        m = re.match(r'^/api/audit/([^/]+)$', path)
        if m:
            return get_audit_for(self, m.group(1))
        m = re.match(r'^/api/attachments/([^/]+)$', path)
        if m:
            return get_attachments_for(self, m.group(1))
        m = re.match(r'^/api/related/cmdb/([^/]+)$', path)
        if m:
            return get_ci_relations(self, m.group(1))
        m = re.match(r'^/api/variables/([^/]+)$', path)
        if m:
            return get_variables_for(self, m.group(1))
        m = re.match(r'^/api/sla-stats/(user|group)/([a-f0-9]{1,32})$', path)
        if m:
            return get_sla_stats(self, m.group(1), m.group(2))
        m = re.match(r'^/api/flow_reconstruction/([a-f0-9]{1,32})$', path)
        if m:
            return get_flow_reconstruction(self, m.group(1))

        m = re.match(r'^/api/([a-z_][a-z_0-9]*)$', path)
        if m:
            return list_table(self, m.group(1), params)
        m = re.match(r'^/api/([a-z_][a-z_0-9]*)/([a-f0-9]{1,32})$', path)
        if m:
            return get_record(self, m.group(1), m.group(2))

        # 404 default
        return _send_error(self, HTTPStatus.NOT_FOUND, f'no route: {path}')


class ReusableServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    if not DB_PATH.is_file():
        log.warning('DB missing at %s — /api endpoints will 500 until you '
                    'run bin/build_sqlite.py on the host.', DB_PATH)
    if not STATIC_HTML.is_file():
        log.error('HistoricalWow.html missing at %s', STATIC_HTML)
        sys.exit(1)
    openapi_yaml = APP_DIR / 'docs' / 'openapi.yaml'
    swagger_index = APP_DIR / 'docs' / 'swagger-ui' / 'index.html'
    if not openapi_yaml.is_file() or not swagger_index.is_file():
        log.warning('docs assets missing at %s — /docs and /openapi.yaml will 404',
                    APP_DIR / 'docs')

    log.info('starting on :%d  app=%s  data=%s  db=%s',
             PORT, APP_DIR, DATA_DIR, 'present' if DB_PATH.is_file() else 'MISSING')
    if hr_gate_enabled():
        log.info('hr gate ENABLED — group=%s (%s)', HR_GROUP_LABEL, HR_GROUP_SYS_ID)
    else:
        log.warning('hr gate DISABLED — set HR_UNLOCK_PASSWORD to protect HR incidents')
    if ACCESS_LOG_PATH:
        log.info('access log ENABLED — %s (dns=%s, max=%d, backups=%d, trust_proxy=%s)',
                 ACCESS_LOG_PATH, 'on' if ACCESS_LOG_DNS else 'off',
                 ACCESS_LOG_MAX, ACCESS_LOG_BACKUPS, 'on' if TRUST_PROXY else 'off')
    else:
        log.info('access log DISABLED — set HISTORICALWOW_ACCESS_LOG to enable')
    # Pre-build the heavy lookup caches on a background thread so the first
    # user-facing request is O(network) instead of O(SQL+gzip). Doesn't
    # block server start — if warmup races against the first request the
    # request just lazy-builds via _serve_cached_lookup.
    if DB_PATH.is_file():
        threading.Thread(target=warm_lookup_cache, daemon=True, name='lookup-warmer').start()
    server = ReusableServer(('0.0.0.0', PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info('shutdown')


if __name__ == '__main__':
    main()
