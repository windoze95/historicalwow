"""Shared, credential-free helpers for the reconciliation harness.

Stdlib only. IMPORTANT: this module — and offline.py — must never import
``historicalwow_export``. That module calls ``sys.exit(2)`` at import time when
the ``SN_*`` env vars are unset (historicalwow_export.py), which would kill an
offline-only run. The live phase imports it lazily, inside functions, after an
env check (see live.get_ex).
"""
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


# ---- verdict ladder --------------------------------------------------------
# Escalation order: PASS/INFO < WARN < FAIL. INFO labels expected, non-failing
# drift (records deleted/edited on source since the snapshot); it is ranked
# equal to PASS so it never lifts a table's rolled-up verdict — the nuance lives
# in the per-record category counts, not the verdict.
PASS, INFO, WARN, FAIL = 'PASS', 'INFO', 'WARN', 'FAIL'
_RANK = {PASS: 0, INFO: 0, WARN: 1, FAIL: 2}


def worst(*verdicts):
    """Return the most severe verdict among the arguments (None/'' ignored).
    INFO collapses to PASS (equal rank), so an informational sub-result cannot
    escalate the rollup."""
    out = PASS
    for v in verdicts:
        if v and _RANK.get(v, 0) > _RANK[out]:
            out = v
    return out


# ---- time ------------------------------------------------------------------
def utc_stamp():
    return datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')


def utc_iso():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


# ---- repo paths ------------------------------------------------------------
def repo_paths():
    """project/, project/data, project/export, project/bin — resolved from this
    file's location (recon/ is a sibling of export/ and bin/)."""
    here = Path(__file__).resolve().parent          # project/recon
    project = here.parent                            # project
    return {
        'project': project,
        'data': project / 'data',
        'export': project / 'export',
        'bin': project / 'bin',
    }


def default_db_path():
    return repo_paths()['data'] / 'historicalwow.db'


# ---- {value, display_value} envelope unwrap --------------------------------
# Mirror build_sqlite._v/_dv and historicalwow_export.field so archive and live
# rows are unwrapped identically on both sides of every comparison.
def uv(obj):
    """The `value` side of an envelope, else the scalar itself."""
    return obj.get('value') if isinstance(obj, dict) else obj


def udv(obj):
    """The `display_value` side (fallback to value), else the scalar itself."""
    if isinstance(obj, dict):
        return obj.get('display_value') or obj.get('value')
    return obj


def is_empty(v):
    """ServiceNow renders an unset field as the empty string; treat that and
    None as empty."""
    return v is None or v == ''


def norm(v):
    """Normalize a value for equality: None collapses to '' (the SN empty
    value), everything else is stringified (SN values arrive as strings; the
    extractor lambdas can yield ints)."""
    return '' if v is None else str(v)


# ---- manifest / state ------------------------------------------------------
def load_manifest(data_dir):
    try:
        return json.loads((Path(data_dir) / 'manifest.json').read_text())
    except (OSError, ValueError):
        return {}


def load_state(data_dir):
    try:
        return json.loads((Path(data_dir) / '_state.json').read_text())
    except (OSError, ValueError):
        return {}


def manifest_by_table(manifest):
    """table -> {'rows', 'source_rows', 'watermark', ...} from manifest.tables[]."""
    out = {}
    for t in manifest.get('tables', []) or []:
        name = t.get('table')
        if name:
            out[name] = t
    return out


def snapshot_cutoff(table, manifest, state):
    """Resolve the as-of cutoff timestamp for a table and where it came from.

    Existence is keyed on creation, so the live count is constrained with
    ``sys_created_on<=<cutoff>`` regardless of a table's delta field. Prefer the
    per-table watermark (authoritative high-water mark in _state.json), then the
    manifest table entry's watermark, then the global manifest captured_at.
    Returns (cutoff_string_or_None, source_label).
    """
    wm = (state.get('watermarks') or {}).get(table)
    if not wm:
        wm = manifest_by_table(manifest).get(table, {}).get('watermark')
    if wm:
        return wm, 'watermark'
    cap = manifest.get('captured_at')           # e.g. 2026-05-01T15:09:00Z
    if cap:
        return cap.replace('T', ' ').replace('Z', '').strip()[:19], 'captured_at'
    return None, 'none'


# ---- read-only DB access ---------------------------------------------------
def open_db_ro(db_path):
    """Open the archive DB read-only. Safe to run alongside the live container,
    which also opens it read-only (SQLite allows concurrent readers)."""
    uri = 'file:%s?mode=ro' % Path(db_path).resolve()
    conn = sqlite3.connect(uri, uri=True, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def db_table_names(conn):
    """User tables only — exclude internal (_build_state) and sqlite_* tables.
    Filtered in Python: a SQL ``NOT LIKE '_%'`` would match every name because
    ``_`` is a single-char LIKE wildcard."""
    names = [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")]
    return sorted(n for n in names
                  if not n.startswith('_') and not n.startswith('sqlite_'))


def table_columns(conn, table):
    return [r[1] for r in conn.execute('PRAGMA table_info("%s")' % table)]


def table_count(conn, table):
    return conn.execute('SELECT COUNT(*) FROM "%s"' % table).fetchone()[0]


def iter_raw(conn, table, limit=None):
    """Stream the `raw` JSON column (parsed). Full scan when limit is None,
    otherwise a uniform random sample. Yields parsed dicts; skips unparseable
    rows (the caller counts them separately via parse stats if needed)."""
    if limit:
        sql = 'SELECT raw FROM "%s" ORDER BY RANDOM() LIMIT %d' % (table, int(limit))
    else:
        sql = 'SELECT raw FROM "%s"' % table
    for (raw,) in conn.execute(sql):
        row = parse_raw(raw)
        if row is not None:
            yield row


def sample_rows(conn, table, n):
    """Uniform random (sys_id, parsed_raw) pairs. ``ORDER BY RANDOM()`` is
    correct for any table size; on multi-million-row tables it costs one scan,
    which is acceptable for a one-shot pre-shutdown gate."""
    out = []
    for sid, raw in conn.execute(
            'SELECT sys_id, raw FROM "%s" ORDER BY RANDOM() LIMIT ?' % table, (n,)):
        out.append((sid, parse_raw(raw)))
    return out


def parse_raw(raw):
    """json.loads with graceful failure (returns None on bad/empty input)."""
    if not raw:
        return None
    try:
        obj = json.loads(raw)
        return obj if isinstance(obj, dict) else None
    except (ValueError, TypeError):
        return None


# ---- misc ------------------------------------------------------------------
def chunked(seq, size):
    """Yield successive lists of at most `size` items."""
    seq = list(seq)
    for i in range(0, len(seq), size):
        yield seq[i:i + size]
