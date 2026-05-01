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
  GET /api/search?q=...&types=incident,problem  → cross-table search
  GET /data/attachments/<...>    → attachment file body (filesystem)
  GET /data/manifest.json        → manifest (compatibility shim for legacy data.js)

DB: /app/data/historicalwow.db (built by bin/build_sqlite.py).
Static root: /app (HistoricalWow.html lives here).
Attachments root: /app/data/attachments (mirror of host disk via volume mount).
"""
import gzip
import json
import logging
import os
import re
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
}
ALL_TABLES = TASK_TABLES | REFERENCE_TABLES


# Per-thread DB connections (sqlite3 doesn't share connections across threads).
_local = threading.local()

def get_conn():
    conn = getattr(_local, 'conn', None)
    if conn is None:
        conn = sqlite3.connect(str(DB_PATH), check_same_thread=False, timeout=30.0)
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
    conn = get_conn()
    row = conn.execute(f'SELECT * FROM "{table}" WHERE sys_id = ?', (sys_id,)).fetchone()
    if not row:
        return _send_error(handler, HTTPStatus.NOT_FOUND, f'{table}/{sys_id} not in archive')
    _json_response(handler, _row_to_dict(row))


def get_journal_for(handler, element_id):
    conn = get_conn()
    rows = conn.execute(
        'SELECT * FROM sys_journal_field WHERE element_id = ? ORDER BY sys_created_on ASC',
        (element_id,)
    ).fetchall()
    _json_response(handler, {'rows': [_row_to_dict(r) for r in rows]})


def get_audit_for(handler, documentkey):
    conn = get_conn()
    rows = conn.execute(
        'SELECT * FROM sys_audit WHERE documentkey = ? ORDER BY sys_created_on ASC',
        (documentkey,)
    ).fetchall()
    _json_response(handler, {'rows': [_row_to_dict(r) for r in rows]})


def get_attachments_for(handler, table_sys_id):
    conn = get_conn()
    rows = conn.execute(
        'SELECT * FROM sys_attachment WHERE table_sys_id = ? ORDER BY sys_created_on ASC',
        (table_sys_id,)
    ).fetchall()
    _json_response(handler, {'rows': [_row_to_dict(r) for r in rows]})


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
    out = []
    conn = get_conn()
    for t in types:
        try:
            rows = conn.execute(
                f'SELECT sys_id, number, short_description, state, priority, '
                f'sys_updated_on, raw FROM "{t}" '
                f'WHERE number LIKE ? OR short_description LIKE ? '
                f'ORDER BY sys_updated_on DESC LIMIT ?',
                (like, like, limit_per_table)
            ).fetchall()
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
    server = ReusableServer(('0.0.0.0', PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info('shutdown')


if __name__ == '__main__':
    main()
