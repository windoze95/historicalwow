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
import gzip
import hmac
import json
import logging
import os
import re
import secrets
import socket
import sqlite3
import sys
import threading
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


APP_DIR    = Path(os.environ.get('HISTORICALWOW_APP', '/app')).resolve()
DATA_DIR   = APP_DIR / 'data'
DB_PATH    = DATA_DIR / 'historicalwow.db'
STATIC_HTML = APP_DIR / 'HistoricalWow.html'

PORT = int(os.environ.get('HISTORICALWOW_PORT', '80'))

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

# Log to stdout so docker logs picks it up.
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)-7s %(message)s',
    datefmt='%H:%M:%S',
    stream=sys.stdout,
)
log = logging.getLogger('historicalwow.server')


# Tables we serve via /api/<table>. Keep in sync with bin/build_sqlite.py.
TASK_TABLES = {
    'incident', 'change_request', 'problem', 'problem_task',
    'sc_request', 'sc_req_item', 'sc_task',
    'incident_task', 'change_task',
    'sysapproval_group', 'asset_task',
}
REFERENCE_TABLES = {
    'sys_user', 'sys_user_group', 'sys_user_grmember',
    'cmdb_ci', 'cmdb_rel_ci',
    'sys_choice', 'core_company', 'cmn_department', 'cmn_location', 'cmn_cost_center',
    'sys_journal_field', 'sys_audit', 'sys_attachment',
    'task_ci', 'task_sla', 'sysapproval_approver',
    'sc_cat_item', 'item_option_new', 'sc_item_option', 'sc_item_option_mtom',
    'question', 'question_choice',
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


def _send_static(handler, path, content_type=None):
    if not path.is_file():
        return _send_error(handler, HTTPStatus.NOT_FOUND, f'not found: {path.name}')
    if content_type is None:
        ext = path.suffix.lower()
        content_type = {
            '.html': 'text/html; charset=utf-8',
            '.css':  'text/css; charset=utf-8',
            '.js':   'application/javascript; charset=utf-8',
            '.json': 'application/json; charset=utf-8',
            '.png':  'image/png',
            '.jpg':  'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.svg':  'image/svg+xml',
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
    cols = [r['name'] for r in conn.execute(f'PRAGMA table_info("{table}")')]
    order_by = order_by_param if (order_by_param in cols) else 'sys_id'

    select_cols = '*' if not slim else ', '.join(f'"{c}"' for c in cols if c != 'raw')

    where = []
    args = []
    # Free-text search on number/short_description if present
    if q:
        like = f'%{q}%'
        text_cols = [c for c in ('number', 'short_description', 'name', 'value') if c in cols]
        if text_cols:
            where.append('(' + ' OR '.join(f'"{c}" LIKE ?' for c in text_cols) + ')')
            args.extend([like] * len(text_cols))
    # Exact-match field filters: any other ?key=value treated as col=value
    RESERVED = {'limit', 'offset', 'q', 'order_by', 'dir', 'slim'}
    for k, vs in params.items():
        if k in RESERVED or k not in cols:
            continue
        where.append(f'"{k}" = ?')
        args.append(vs[0] if vs else '')

    # HR gate: hide incidents assigned to the HR group when the request
    # isn't unlocked. Only `incident` is gated — same table the user asked
    # about — but the same predicate would extend to other task tables.
    if table == 'incident' and not is_hr_unlocked(handler):
        where.append('"assignment_group" IS NOT ?')
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
    if table == 'incident' and not is_hr_unlocked(handler) and is_hr_record(sys_id):
        return _send_error(handler, HTTPStatus.FORBIDDEN, 'hr_locked')
    conn = get_conn()
    row = conn.execute(f'SELECT * FROM "{table}" WHERE sys_id = ?', (sys_id,)).fetchone()
    if not row:
        return _send_error(handler, HTTPStatus.NOT_FOUND, f'{table}/{sys_id} not in archive')
    _json_response(handler, _row_to_dict(row))


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
        if t == 'incident' and not hr_unlocked:
            sql += ' AND assignment_group IS NOT ?'
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


def get_manifest(handler):
    p = DATA_DIR / 'manifest.json'
    if not p.is_file():
        return _send_error(handler, HTTPStatus.NOT_FOUND, 'manifest.json missing')
    _send_static(handler, p, content_type='application/json; charset=utf-8')


def get_cmdb_ci_lookup(handler):
    """Compact CI lookup table: sys_id → {name, sys_class_name, operational_status}.
    Used by the viewer's findCI() helper without loading all 1M full records."""
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
    _json_response(handler, out, cache_seconds=300)


def get_hr_status(handler):
    _json_response(handler, {
        'enabled': hr_gate_enabled(),
        'unlocked': is_hr_unlocked(handler),
        'group_sys_id': HR_GROUP_SYS_ID,
        'group_label': HR_GROUP_LABEL,
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
    """Compact user lookup table: sys_id → {name, user_name, title, department, location}.
    Used by the viewer's findUser() helper without loading all 142k full envelopes."""
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
    _json_response(handler, out, cache_seconds=300)


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
    'task_ci', 'task_sla', 'sysapproval_approver',
}


# --- routing --------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = 'historicalwow/1'

    # Quiet the default access log; we'll log selectively below.
    def log_message(self, fmt, *args):
        # Don't print the noisy default; keep our own log.
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

        # Attachment file bodies
        if path.startswith('/data/attachments/'):
            rel = path[len('/data/'):]
            target = (DATA_DIR / rel).resolve()
            # Path traversal guard
            try:
                target.relative_to(DATA_DIR)
            except ValueError:
                return _send_error(self, HTTPStatus.FORBIDDEN, 'forbidden path')
            return _send_static(self, target)

        # API
        if path == '/api/manifest':
            return get_manifest(self)
        if path == '/api/cmdb_ci_lookup':
            return get_cmdb_ci_lookup(self)
        if path == '/api/sys_user_lookup':
            return get_sys_user_lookup(self)
        if path == '/api/hr-status':
            return get_hr_status(self)
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

    log.info('starting on :%d  app=%s  data=%s  db=%s',
             PORT, APP_DIR, DATA_DIR, 'present' if DB_PATH.is_file() else 'MISSING')
    if hr_gate_enabled():
        log.info('hr gate ENABLED — group=%s (%s)', HR_GROUP_LABEL, HR_GROUP_SYS_ID)
    else:
        log.warning('hr gate DISABLED — set HR_UNLOCK_PASSWORD to protect HR incidents')
    server = ReusableServer(('0.0.0.0', PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info('shutdown')


if __name__ == '__main__':
    main()
