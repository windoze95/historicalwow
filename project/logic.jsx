/* eslint-disable */
// Logic — business rules, client scripts, script includes, scheduled jobs,
// UI policies, data policies. Surfaces every server-side and client-side
// scripting record ingested from the ServiceNow instance, plus a per-table
// "what runs on this table" inspector reachable from anywhere in the app.
//
// Data layer: hits /api/sys_script, /api/sys_script_client,
// /api/sys_script_include, /api/sysauto_script, /api/sys_ui_policy,
// /api/sys_ui_policy_action, /api/sys_data_policy2, /api/sys_data_policy_rule
// — same shape as catalog.jsx, with the same fetchTable graceful-missing
// wrapper so tabs whose backing table isn't in this snapshot render
// "(not in this snapshot)" instead of blowing up.

(function () {
  const data = window.HistoricalWowData;

  const _cache = new Map();
  function fetchCached(key, fetcher, ttlMs = 60_000) {
    const e = _cache.get(key);
    const now = Date.now();
    if (e && (e.promise || (e.value && now - e.ts < ttlMs))) {
      return e.promise || Promise.resolve(e.value);
    }
    const p = fetcher().then(v => { _cache.set(key, { value: v, ts: Date.now() }); return v; });
    _cache.set(key, { promise: p });
    return p;
  }

  // Same wrapper as catalog.jsx: graceful "missing" handling so tabs
  // whose backing table hasn't been ingested yet don't crash the page.
  async function fetchTable(table, opts = {}) {
    try {
      const r = await data.fetchTaskList(table, opts);
      return { rows: r.rows || [], total: r.total || 0, missing: false };
    } catch (e) {
      const msg = (e && e.message) || '';
      if (/HTTP 404|HTTP 500|unknown table|no such table/i.test(msg)) {
        return { rows: [], total: 0, missing: true, error: msg };
      }
      return { rows: [], total: 0, missing: true, error: msg };
    }
  }

  // Page through every row matching opts. Used for the script-include
  // name index (we want every include name, not just the first 200).
  async function fetchAllRows(table, opts = {}, hardCap = 50_000) {
    const pageSize = Math.min(opts.limit || 5000, 5000);
    let rows = [];
    let total = null;
    let offset = 0;
    while (offset < hardCap) {
      const r = await fetchTable(table, { ...opts, limit: pageSize, offset });
      if (r.missing) return { rows: [], total: 0, missing: true };
      if (total === null) total = r.total || 0;
      rows = rows.concat(r.rows);
      if (r.rows.length < pageSize) break;
      if (rows.length >= total) break;
      offset += pageSize;
    }
    return { rows, total: total || rows.length, missing: false };
  }

  // Script-include name index. Loaded lazily on first record view that
  // needs it, then cached for the rest of the session.
  //
  // Two-pass scan. The previous eager-precompile approach kept one
  // RegExp per include in memory — at ~thousands of includes that's
  // enough compiled-pattern state to OOM the tab on a heavy table.
  // Instead:
  //
  //   (1) A single coarse alternation regex covers every include name,
  //       partitioned into a few buckets so any one regex stays under
  //       V8's pattern-size envelope. Test once per body to find any
  //       name occurrence anywhere — comments included, fine.
  //   (2) A name → include[] map turns each coarse hit into a
  //       candidate include set (a name can map to multiple records
  //       when the snapshot has duplicates across scopes).
  //   (3) Strict call-shape patterns are compiled *lazily* per
  //       candidate include — most includes are never candidates so
  //       their RegExp is never constructed.
  //
  // Result: peak compiled-regex memory is the coarse buckets (~a
  // dozen) plus however many candidate strict patterns the active
  // table happens to touch (typically <200), not thousands.
  //
  // What "call-shape" means: a match requires the include's name to
  // appear in a position that looks like an actual call (constructor,
  // dotted method, prototype extension, class/object extension,
  // gs.include / GlideAjax string literal). Bare mentions in comments
  // or unrelated identifiers don't qualify, which keeps the recursive
  // cascade from following the dictionary of common identifiers.
  // Names that match a JS or platform built-in we can never tell
  // apart from an override. If a customer has a script include named
  // `JSON`, every `JSON.parse(...)` in every body still resolves to
  // the native built-in at runtime — and the cascade scanner can't
  // distinguish. Treating those calls as references to the include
  // (which they technically are at the language level, sometimes)
  // sucks the entire dependency graph through a single high-traffic
  // node. Skip these names from the index entirely.
  //
  // Platform built-ins (GlideRecord, GlideSystem, GlideAjax, …) are
  // not script includes anyway — they live in Java — so no real
  // include should be named after them. Including them in the
  // blocklist is belt-and-suspenders in case a snapshot happens to
  // carry an override.
  const BUILTIN_NAME_BLOCKLIST = new Set([
    // ES + DOM globals
    'Array','ArrayBuffer','BigInt','Boolean','Date','Error','EvalError',
    'Function','Infinity','JSON','Map','Math','NaN','Number','Object',
    'Promise','Proxy','RangeError','ReferenceError','Reflect','RegExp',
    'Set','String','Symbol','SyntaxError','TypeError','URIError','WeakMap',
    'WeakSet','console','document','globalThis','navigator','undefined',
    'window',
    // ServiceNow platform classes commonly seen as identifiers
    'GlideAggregate','GlideAjax','GlideDate','GlideDateTime','GlideDuration',
    'GlideElement','GlideForm','GlideList','GlideRecord','GlideScheduleDateTime',
    'GlideScopedEvaluator','GlideSystem','GlideTime','GlideUser','GlideURI',
    'gs','g_form','g_user','g_scratchpad',
  ]);
  // Two builder groups so blocklisted names only contribute the
  // unambiguous string-literal forms. `gs.include('JSON')` and
  // `new GlideAjax('JSON')` are obvious references to a customer
  // include named JSON — the include name is in a quoted string,
  // can't be confused with the native built-in. Identifier-context
  // forms (`new JSON(`, `JSON.method(`, etc.) collide with the
  // native built-in and would over-pull.
  const IDENTIFIER_BUILDERS = [
    (e) => 'new\\s+' + e + '\\s*\\(',
    (e) => '\\b' + e + '\\.[A-Za-z_$][\\w$]*\\s*\\(',
    (e) => '\\b' + e + '\\.prototype\\b',
    (e) => '\\bextends\\s+' + e + '\\b',
    (e) => '\\bextendsObject\\s*\\(\\s*' + e + '\\b',
  ];
  const STRING_LITERAL_BUILDERS = [
    (e) => "gs\\.include\\(\\s*['\"]" + e + "['\"]\\s*\\)",
    (e) => "new\\s+GlideAjax\\s*\\(\\s*['\"]" + e + "['\"]",
  ];
  function escRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  function buildStrictPattern(allNames) {
    const parts = [];
    for (const n of allNames) {
      if (!n || n.length < 3) continue;
      const e = escRegex(n);
      const builders = BUILTIN_NAME_BLOCKLIST.has(n)
        ? STRING_LITERAL_BUILDERS
        : [...IDENTIFIER_BUILDERS, ...STRING_LITERAL_BUILDERS];
      for (const build of builders) parts.push(build(e));
    }
    if (!parts.length) return null;
    try { return new RegExp(parts.join('|')); }
    catch (_) { return null; }
  }
  // Partition into ~500-name buckets so the joined alternation stays
  // small. V8 will compile each into an efficient trie-like NFA; a
  // single 6800-way alternation can refuse to compile on some
  // versions.
  function buildCoarseBuckets(allNamesSorted) {
    const BUCKET = 500;
    const out = [];
    for (let i = 0; i < allNamesSorted.length; i += BUCKET) {
      const chunk = allNamesSorted.slice(i, i + BUCKET).map(escRegex);
      if (!chunk.length) continue;
      try { out.push(new RegExp('\\b(?:' + chunk.join('|') + ')\\b', 'g')); }
      catch (_) { /* skip bucket on compile failure rather than fail all */ }
    }
    return out;
  }
  // Out-of-box ServiceNow includes are authored by a small set of
  // platform users (admin, maint, glide.maint, the now.* system users
  // for Discovery / patterns / etc.). They're the bulk of every
  // instance and the cascade has no reason to walk them — the
  // customer-meaningful logic is in the includes a real human has
  // touched. An include is "user-touched" iff at least one of
  // sys_created_by / sys_updated_by is a real user; pure-system
  // includes are dropped from the index entirely.
  function isSystemAuthor(u) {
    if (!u) return true;
    const v = String(u).toLowerCase();
    return v === 'admin' || v === 'system' || v === 'maint' || v === 'guest'
        || v.startsWith('glide.')   // glide.maint, glide.installer
        || v.startsWith('now.')     // now.discovery_infra, now.patterns, now.cpg, …
        || v.startsWith('system.');
  }
  let _includeIndex = null;
  let _scanCtx = null;
  function getIncludeIndex() {
    if (_includeIndex) return _includeIndex;
    _includeIndex = fetchAllRows('sys_script_include', {
      order_by: 'name', dir: 'asc',
    }).then(r => {
      if (r.missing) { _scanCtx = { coarseBuckets: [], nameMap: new Map() }; return []; }
      const userTouched = r.rows.filter(row =>
        !isSystemAuthor(row.sys_created_by) || !isSystemAuthor(row.sys_updated_by)
      );
      const list = userTouched.map(row => {
        const sid = row.sys_id;
        const name = String(row.name || '').trim();
        const api  = String(row.api_name || '').trim();
        const names = new Set();
        if (name) names.add(name);
        if (api) {
          names.add(api);
          const tail = api.split('.').pop();
          if (tail) names.add(tail);
        }
        // Note: we keep blocklisted bare names in all_names. The
        // coarse pass still adds them as candidates, but the strict
        // pattern compiled by buildStrictPattern restricts those
        // names to string-literal call-shapes (gs.include('JSON'),
        // new GlideAjax('JSON')) — so an unambiguous reference still
        // resolves, while bare JSON.parse(...) doesn't drag the
        // override include into the cascade.
        return {
          sys_id: sid, name, api_name: api, all_names: [...names],
          _pattern: undefined,   // lazy-compiled in scanForIncludes
        };
      });
      // Collect every name worth scanning, deduped. Sort by length
      // descending so V8's regex alternation prefers longer matches
      // (avoids "Schedule" winning over "ScheduleEntry" on input
      // where both appear).
      const nameSet = new Set();
      const nameMap = new Map();
      for (const inc of list) {
        for (const n of inc.all_names) {
          if (!n || n.length < 3) continue;
          nameSet.add(n);
          if (!nameMap.has(n)) nameMap.set(n, []);
          nameMap.get(n).push(inc);
        }
      }
      const sorted = [...nameSet].sort((a, b) => b.length - a.length || a.localeCompare(b));
      _scanCtx = {
        coarseBuckets: buildCoarseBuckets(sorted),
        nameMap,
      };
      return list;
    }).catch(() => {
      _scanCtx = { coarseBuckets: [], nameMap: new Map() };
      return [];
    });
    return _includeIndex;
  }

  // Reverse index: include sys_id → list of scripts that reference it,
  // built by paging every business rule / client script / scheduled job
  // and running the same word-boundary scan that record pages use.
  // Required because `/api/<table>?q=` only searches indexed columns
  // (number / short_description / name / value), and we deliberately
  // don't index the `script` body — counts via `q=` would be 0 or hit
  // unrelated name matches. Lazy + session-cached: first include record
  // pays ~3 paged fetches and a regex scan, subsequent renders read
  // from the Map. Scripts are GC'd table-by-table so peak memory is
  // bounded to one table's body footprint at a time.
  let _reverseIncludeIndex = null;
  function getReverseIncludeIndex() {
    if (_reverseIncludeIndex) return _reverseIncludeIndex;
    _reverseIncludeIndex = (async () => {
      const includes = await getIncludeIndex();
      const out = { byId: new Map(), missing: {} };
      for (const inc of includes) out.byId.set(inc.sys_id, []);
      const sources = [
        { table: 'sys_script',        label: 'business rule', url: '/business-rules' },
        { table: 'sys_script_client', label: 'client script', url: '/client-scripts' },
        { table: 'sysauto_script',    label: 'scheduled job', url: '/scheduled-jobs' },
      ];
      for (const s of sources) {
        const r = await fetchAllRows(s.table, { order_by: 'sys_id', dir: 'asc' });
        if (r.missing) { out.missing[s.table] = true; continue; }
        for (const row of r.rows) {
          const body = row.script ? String(row.script) : '';
          if (!body) continue;
          const hits = scanForIncludes(body, includes);
          for (const inc of hits) {
            out.byId.get(inc.sys_id).push({
              table: s.table, label: s.label, url: s.url,
              sys_id: row.sys_id,
              name: row.name || '(unnamed)',
            });
          }
        }
      }
      return out;
    })();
    return _reverseIncludeIndex;
  }

  // Scan an arbitrary script body for include references using the
  // two-pass approach: bucketed coarse alternation finds candidates
  // by bare-name occurrence, then we lazy-compile and test each
  // candidate's strict call-shape pattern. Memory at any moment is
  // bounded by the candidate count (typically <200) rather than the
  // full include count (thousands).
  //
  // The `includes` parameter is accepted for back-compat with older
  // callers but ignored — the scan reads from the module-level
  // _scanCtx populated by getIncludeIndex().
  function scanForIncludes(text /*, includes */) {
    if (!text || !_scanCtx) return [];
    const candidates = new Set();
    for (const re of _scanCtx.coarseBuckets) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const incs = _scanCtx.nameMap.get(m[0]);
        if (incs) for (const inc of incs) candidates.add(inc);
      }
    }
    const hits = new Map();
    for (const inc of candidates) {
      if (inc._pattern === undefined) {
        // Lazy compile, cached on the include record itself. `false`
        // marks "tried and failed", `null` marks "no eligible names".
        inc._pattern = buildStrictPattern(inc.all_names) || false;
      }
      if (!inc._pattern) continue;
      try {
        if (inc._pattern.test(text)) hits.set(inc.sys_id, inc);
      } catch (_) {
        // Per-include failure — skip and keep scanning.
      }
    }
    return [...hits.values()];
  }

  const L = {
    fetchTable,
    fetchAllRows,
    getIncludeIndex,
    getReverseIncludeIndex,
    scanForIncludes,
    fetchRecord: (table, sys_id) => data.fetchRecord(table, sys_id),
    fetchTotalCount: (table) => fetchCached('count_' + table, async () => {
      const r = await fetchTable(table, { limit: 1 });
      return { total: r.total, missing: r.missing };
    }, 30_000),
    // Grouped counts for the home dashboard's "top tables" lists.
    // Pages every row of `table` and tallies by `groupBy` column, then
    // returns top N. group-by is fast enough at ~10k row scale because
    // the column is an indexed string. Cached so re-renders don't refetch.
    fetchTopTables: (table, groupBy, topN = 12) => fetchCached(
      `top_${table}_${groupBy}_${topN}`,
      async () => {
        const r = await fetchAllRows(table, { order_by: 'sys_id', dir: 'asc' });
        if (r.missing) return { missing: true, items: [] };
        const m = new Map();
        for (const row of r.rows) {
          const v = String(row[groupBy] || row['__display_' + groupBy] || '').trim();
          if (!v) continue;
          m.set(v, (m.get(v) || 0) + 1);
        }
        const items = [...m.entries()]
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, topN);
        return { items, total: r.rows.length, missing: false };
      },
      120_000,
    ),
  };
  L._cache = _cache;
  window.HistoricalWowLogic = L;
})();

// ===========================================================================
// UI
// ===========================================================================

(function () {
  const L = window.HistoricalWowLogic;
  const data = window.HistoricalWowData;
  const { useState, useEffect, useMemo } = React;

  const chip = {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '2px 8px', borderRadius: 10, fontSize: 11,
    background: 'var(--bg-3)', border: '1px solid var(--border)', color: 'var(--fg-2)',
  };

  // when chip → catalog.jsx-style color palette. before/after/async/display
  // map to ServiceNow business-rule "when" values. Falls back to the
  // neutral gray chip for unknown values (e.g. _empty for client scripts).
  const WHEN_COLOR = {
    before:  'blue',
    after:   'green',
    async:   'violet',
    display: 'amber',
  };
  function WhenChip({ when, label }) {
    const k = String(when || '').toLowerCase();
    const cls = WHEN_COLOR[k];
    if (!cls) return <span style={chip}>{label || when || '—'}</span>;
    return <span className={`chip ${cls}`}>{label || when}</span>;
  }

  // Client-script type chips: onLoad/onChange/onSubmit/onCellEdit.
  const CS_TYPE_COLOR = {
    onLoad: 'blue', onChange: 'amber', onSubmit: 'violet', onCellEdit: 'green',
  };
  function ClientScriptTypeChip({ type }) {
    const cls = CS_TYPE_COLOR[type];
    if (!cls) return <span style={chip}>{type || '—'}</span>;
    return <span className={`chip ${cls}`}>{type}</span>;
  }

  const flat = (v) => (v && typeof v === 'object' && 'value' in v) ? v.value : v;
  const dv = (r, k) => r['__display_' + k] || flat(r[k]);
  const isTrue = (v) => v === true || v === 'true' || v === 1 || v === '1';

  function Loading({ label = 'loading…' }) {
    return (
      <div style={{ padding: '24px 12px', color: 'var(--fg-4)', fontSize: 12.5, textAlign: 'center' }}>
        <span className="dot-pulse" style={{ display: 'inline-block', marginRight: 8 }} />
        {label}
      </div>
    );
  }
  function Empty({ icon = 'info', text, hint }) {
    return (
      <div style={{
        background: 'var(--bg-elev)', border: '1px dashed var(--border)', borderRadius: 8,
        padding: '20px 16px', color: 'var(--fg-4)', fontSize: 12.5, textAlign: 'center',
      }}>
        <window.Icon name={icon} size={14} />
        <div style={{ marginTop: 6 }}>{text}</div>
        {hint && <div style={{ marginTop: 4, fontSize: 11, color: 'var(--fg-4)', fontStyle: 'italic' }}>{hint}</div>}
      </div>
    );
  }
  function NotInSnapshot({ table }) {
    return (
      <Empty
        icon="archive"
        text={<>The <span className="mono" style={{ fontSize: 11.5 }}>{table}</span> table isn't in this snapshot.</>}
        hint={<>Add it to <span className="mono" style={{ fontSize: 11 }}>project/export/historicalwow_export.py</span> DEFAULT_TABLES, run the exporter, and rebuild the SQLite DB.</>}
      />
    );
  }
  function Field({ label, children }) {
    return (
      <>
        <div style={{ color: 'var(--fg-3)', fontSize: 12 }}>{label}</div>
        <div style={{ fontSize: 12.5 }}>{children}</div>
      </>
    );
  }

  // Monospace code-preview block. Used for full script bodies and snippets.
  // Mirrors the ClientScriptsTab style in catalog.jsx but slightly taller
  // because logic scripts are routinely 200+ lines.
  function CodeBlock({ children, maxHeight = 420 }) {
    return (
      <pre style={{
        margin: 0, padding: '10px 12px',
        background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
        fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--fg-2)',
        overflowX: 'auto', overflowY: 'auto',
        whiteSpace: 'pre-wrap', maxHeight,
      }}>{children}</pre>
    );
  }

  // Page header used by every list page in this module — matches the look
  // of catalog.jsx + lists.jsx without dragging in their per-table logic.
  function PageHeader({ title, sub, table, total, matching, page, lastPage, children }) {
    return (
      <div className="page-header">
        <h1>{title} {total != null && <span className="count mono">{total.toLocaleString()}</span>}</h1>
        <div className="sub">
          <span className="mono" style={{ color: 'var(--fg-4)' }}>{table}</span>
          {matching != null && <> · {matching.toLocaleString()} matching</>}
          {page != null && lastPage != null && <> · page {page + 1} of {lastPage + 1}</>}
          {sub && <> · {sub}</>}
        </div>
        {children && <div className="toolbar">{children}</div>}
      </div>
    );
  }

  function Pager({ page, setPage, lastPage }) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
        <button className="filter-pill" disabled={page === 0} onClick={() => setPage(0)}>« first</button>
        <button className="filter-pill" disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>‹ prev</button>
        <button className="filter-pill" disabled={page >= lastPage} onClick={() => setPage(p => Math.min(lastPage, p + 1))}>next ›</button>
        <button className="filter-pill" disabled={page >= lastPage} onClick={() => setPage(lastPage)}>last »</button>
      </div>
    );
  }

  // Reusable: short_description truncated to one row, name above it.
  function NameWithDesc({ name, desc }) {
    return (
      <>
        <strong style={{ fontWeight: 500, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 480 }}>
          {name || '(unnamed)'}
        </strong>
        {desc && (
          <div style={{ fontSize: 11, color: 'var(--fg-4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 480 }}>
            {desc}
          </div>
        )}
      </>
    );
  }

  // Breadcrumb back to the parent SN table inspector — used on every
  // record page in this module. `name` is the SN table name like
  // "incident" or "change_request".
  function TableCrumb({ name }) {
    if (!name) return null;
    return (
      <a onClick={() => window.navigate(`/sn-table/${name}`)} className="mono">
        {name}
      </a>
    );
  }

  // =========================================================================
  // Logic home dashboard
  // =========================================================================
  window.LogicHomePage = function LogicHomePage() {
    const [counts, setCounts] = useState(null);
    const [topBR, setTopBR]   = useState(null);
    const [topCS, setTopCS]   = useState(null);
    const [q, setQ]           = useState('');

    useEffect(() => {
      window.AuditLog.push('view', 'logic', 'Server/client-side logic overview');
      let cancel = false;
      Promise.all([
        'sys_script', 'sys_script_client', 'sys_script_include',
        'sysauto_script', 'sys_ui_policy', 'sys_ui_policy_action',
        'sys_data_policy2', 'sys_data_policy_rule',
      ].map(t => L.fetchTotalCount(t).then(r => [t, r]))).then(pairs => {
        if (cancel) return;
        const m = {};
        for (const [t, r] of pairs) m[t] = r;
        setCounts(m);
      });
      L.fetchTopTables('sys_script', 'collection', 12).then(r => { if (!cancel) setTopBR(r); });
      L.fetchTopTables('sys_script_client', 'table', 12).then(r => { if (!cancel) setTopCS(r); });
      return () => { cancel = true; };
    }, []);

    const onSearchSubmit = (e) => {
      e.preventDefault();
      const t = q.trim();
      if (!t) return;
      window.navigate(`/sn-table/${t}`);
    };

    if (counts === null) {
      return (
        <div style={{ padding: '32px 32px 60px', maxWidth: 1200, margin: '0 auto' }}>
          <h1 style={{ fontSize: 26, fontWeight: 600 }}>Logic overview</h1>
          <Loading label="Loading logic counts…" />
        </div>
      );
    }

    const tile = (label, table, url) => {
      const c = counts[table];
      const missing = c && c.missing;
      return (
        <div onClick={() => url && !missing && window.navigate(url)}
             style={{
               background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8,
               padding: '12px 14px', cursor: (url && !missing) ? 'pointer' : 'default',
             }}>
          <div style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{label}</div>
          <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-.02em', marginTop: 4, fontFamily: 'var(--font-mono)' }}>
            {missing ? '—' : (c?.total ?? 0).toLocaleString()}
          </div>
          <div style={{ fontSize: 11, color: 'var(--fg-4)', marginTop: 2 }}>
            {missing ? `${table} not in snapshot` : <span className="mono">{table}</span>}
          </div>
        </div>
      );
    };

    return (
      <div style={{ padding: '32px 32px 60px', maxWidth: 1200, margin: '0 auto' }}>
        <div style={{ marginBottom: 26 }}>
          <div style={{ fontSize: 11.5, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '.08em', fontWeight: 600 }}>
            Server-side / Client-side Logic
          </div>
          <h1 style={{ margin: '6px 0 8px', fontSize: 26, fontWeight: 600, letterSpacing: '-0.02em' }}>
            Logic overview
          </h1>
          <div style={{ color: 'var(--fg-3)', fontSize: 13.5, maxWidth: 760, lineHeight: 1.6 }}>
            Every business rule, client script, script include, scheduled job, UI policy, and
            data policy in this snapshot. Use the per-table inspector to see exactly which
            logic runs on a given ServiceNow table.
          </div>
        </div>

        <form onSubmit={onSearchSubmit} style={{ marginBottom: 22, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, flex: 1,
            background: 'var(--bg-elev)', border: '1px solid var(--border-2)',
            borderRadius: 10, padding: '10px 14px',
          }}>
            <window.Icon name="search" size={14} />
            <input value={q} onChange={e => setQ(e.target.value)}
                   placeholder="Inspect a ServiceNow table by name — e.g. incident, change_request, cmdb_ci…"
                   style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent',
                            color: 'var(--fg)', fontSize: 13.5, fontFamily: 'var(--font-sans)' }} />
            <button type="submit" className="toggle on" style={{ padding: '4px 12px', fontSize: 12 }}>Inspect →</button>
          </div>
        </form>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 26 }}>
          {tile('Business rules',  'sys_script',          '/business-rules')}
          {tile('Client scripts',  'sys_script_client',   '/client-scripts')}
          {tile('Script includes', 'sys_script_include',  '/script-includes')}
          {tile('Scheduled jobs',  'sysauto_script',      '/scheduled-jobs')}
          {tile('UI policies',     'sys_ui_policy',       '/ui-policies')}
          {tile('Data policies',   'sys_data_policy2',    '/data-policies')}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22 }}>
          <TopTablesPanel
            title="Top tables by business-rule count"
            sub="sys_script grouped by collection"
            data={topBR}
          />
          <TopTablesPanel
            title="Top tables by client-script count"
            sub="sys_script_client grouped by table"
            data={topCS}
          />
        </div>
      </div>
    );
  };

  function TopTablesPanel({ title, sub, data }) {
    return (
      <div>
        <h2 style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--fg-3)', margin: '0 0 10px' }}>
          {title}
          {sub && <span className="mono" style={{ color: 'var(--fg-4)', marginLeft: 8, textTransform: 'none', letterSpacing: 0 }}>{sub}</span>}
        </h2>
        <div style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          {data == null ? <Loading /> : data.missing ? (
            <div style={{ padding: 18 }}><NotInSnapshot table={data.table || 'source table'} /></div>
          ) : data.items.length === 0 ? (
            <div style={{ padding: 24, color: 'var(--fg-4)', fontSize: 12.5, textAlign: 'center' }}>
              No grouping data available.
            </div>
          ) : (
            <table className="dt" style={{ width: '100%' }}>
              <thead><tr>
                <th>ServiceNow table</th>
                <th style={{ width: 80 }} className="num">Count</th>
              </tr></thead>
              <tbody>
                {data.items.map(t => (
                  <tr key={t.name} onClick={() => window.navigate(`/sn-table/${t.name}`)}>
                    <td className="mono" style={{ fontSize: 12 }}>{t.name}</td>
                    <td className="num mono">{t.count.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  // =========================================================================
  // Generic list page — shared by all six list views.
  // =========================================================================
  // Backing tables here all live in /api/<table> with the same shape, so
  // rather than copy-pasting the TaskList scaffolding six times we drive
  // it from a column-spec. Each entry knows how to render its cell from
  // the row + helper. `filters` are <select>/toggle dropdowns the caller
  // can plug in (e.g. when=before/after/async/display for sys_script).
  const PAGE_SIZE = 50;
  function LogicListShell({
    table, title, columns,
    extraFilters,            // [{ key, label, options: [{value,label}], default }]
    searchFields,            // text fields the server's `q` covers
    defaultOrderBy = 'name',
    defaultDir = 'asc',
    onRowClick,
  }) {
    const [q, setQ] = useState('');
    const [debouncedQ, setDebouncedQ] = useState('');
    const [page, setPage] = useState(0);
    const [resp, setResp] = useState({ rows: null, total: 0 });
    const [loading, setLoading] = useState(true);
    const [filters, setFilters] = useState(
      () => Object.fromEntries((extraFilters || []).map(f => [f.key, f.default ?? '']))
    );
    const [activeOnly, setActiveOnly] = useState(false);

    useEffect(() => {
      const t = setTimeout(() => setDebouncedQ(q), 250);
      return () => clearTimeout(t);
    }, [q]);
    useEffect(() => { setPage(0); }, [debouncedQ, JSON.stringify(filters), activeOnly]);

    useEffect(() => {
      window.AuditLog.push('list', table, '');
    }, [table]);

    useEffect(() => {
      let cancel = false;
      setLoading(true);
      const flt = {};
      for (const [k, v] of Object.entries(filters)) if (v) flt[k] = v;
      if (activeOnly) flt.active = 'true';
      data.fetchTaskList(table, {
        limit: PAGE_SIZE, offset: page * PAGE_SIZE,
        q: debouncedQ || undefined,
        filters: flt,
        order_by: defaultOrderBy, dir: defaultDir,
      }).then(r => {
        if (cancel) return;
        setResp(r);
        setLoading(false);
      }).catch(() => {
        if (cancel) return;
        setResp({ rows: [], total: 0, missing: true });
        setLoading(false);
      });
      return () => { cancel = true; };
    }, [table, debouncedQ, page, JSON.stringify(filters), activeOnly]);

    const manifestEntry = data.manifest.tables.find(t => t.table === table);
    const sourceCount = manifestEntry ? manifestEntry.source_rows : null;
    const total = resp.total || 0;
    const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

    const click = onRowClick || ((r) => window.navigate(window.recordUrl(table, r.sys_id)));
    const _missing = !manifestEntry || (manifestEntry.source_rows === 0 && !loading && resp.rows && resp.rows.length === 0 && total === 0);

    return (
      <div>
        <PageHeader title={title} table={table} total={sourceCount} matching={total} page={page} lastPage={lastPage}>
          {(extraFilters || []).map(f => (
            <select key={f.key} value={filters[f.key]} onChange={e => setFilters(prev => ({ ...prev, [f.key]: e.target.value }))}
              style={{ height: 26, padding: '0 10px', border: '1px solid var(--border-2)', borderRadius: 14, background: 'var(--bg-elev)', fontSize: 12, color: 'var(--fg)', outline: 'none' }}>
              <option value="">All — {f.label}</option>
              {f.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ))}
          <button className={'toggle' + (activeOnly ? ' on' : '')} onClick={() => setActiveOnly(v => !v)}
            style={{ padding: '0 12px', height: 26, fontSize: 12, borderRadius: 14 }}>
            active only
          </button>
          <div className="spacer" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={`Search ${(searchFields || ['name']).join(' / ')}…`}
            style={{ height: 26, padding: '0 10px', border: '1px solid var(--border-2)', borderRadius: 14, background: 'var(--bg-elev)', fontSize: 12, outline: 'none', width: 280, color: 'var(--fg)' }} />
          <Pager page={page} setPage={setPage} lastPage={lastPage} />
        </PageHeader>
        <table className="dt">
          <thead><tr>
            {columns.map(c => (
              <th key={c.key} style={{ width: c.w }} className={c.cls}>{c.label}</th>
            ))}
          </tr></thead>
          <tbody>
            {loading && resp.rows == null && (
              <tr><td colSpan={columns.length} style={{ padding: '60px 20px', color: 'var(--fg-4)', textAlign: 'center' }}>
                <span className="dot-pulse" style={{ display: 'inline-block', marginRight: 8 }} />
                loading…
              </td></tr>
            )}
            {!loading && resp.missing && (
              <tr><td colSpan={columns.length} style={{ padding: '40px 20px' }}><NotInSnapshot table={table} /></td></tr>
            )}
            {!loading && resp.rows && resp.rows.length === 0 && !resp.missing && (
              <tr><td colSpan={columns.length} style={{ padding: '40px 20px', color: 'var(--fg-4)', textAlign: 'center' }}>No matching records.</td></tr>
            )}
            {(resp.rows || []).map(r => (
              <tr key={r.sys_id} onClick={() => click(r)}>
                {columns.map(c => <td key={c.key} className={c.cls} style={c.tdStyle}>{c.render(r)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // =========================================================================
  // Business rules (sys_script)
  // =========================================================================
  window.BusinessRuleListPage = function BusinessRuleListPage() {
    const columns = [
      { key: 'name', label: 'Name', render: r => (
        <NameWithDesc name={flat(r.name)} desc={flat(r.description) || flat(r.short_description)} />
      )},
      { key: 'collection', label: 'Target table', w: 200, render: r => {
        const t = flat(r.collection);
        return t ? (
          <a className="mono" style={{ fontSize: 12 }} onClick={(e) => { e.stopPropagation(); window.navigate(`/sn-table/${t}`); }}>{t}</a>
        ) : <span className="muted">—</span>;
      }},
      { key: 'when', label: 'When', w: 110, render: r => <WhenChip when={flat(r.when) || dv(r, 'when')} /> },
      { key: 'order', label: 'Order', w: 70, cls: 'num', render: r => (
        <span className="mono">{flat(r.order) ?? '—'}</span>
      )},
      { key: 'active', label: 'Active', w: 80, render: r => (
        isTrue(flat(r.active)) ? <span className="chip green">active</span> : <span className="chip">inactive</span>
      )},
      { key: 'cond', label: 'Conditions', w: 90, render: r => (
        flat(r.condition) || flat(r.filter_condition)
          ? <span style={chip}>has filter</span>
          : <span className="muted">—</span>
      )},
    ];
    return (
      <LogicListShell
        table="sys_script"
        title="Business rules"
        columns={columns}
        defaultOrderBy="name"
        defaultDir="asc"
        searchFields={['name', 'description']}
        extraFilters={[
          { key: 'when', label: 'when', options: [
            { value: 'before', label: 'before' },
            { value: 'after',  label: 'after' },
            { value: 'async',  label: 'async' },
            { value: 'display', label: 'display' },
          ]},
        ]}
      />
    );
  };

  // =========================================================================
  // Client scripts (sys_script_client)
  // =========================================================================
  window.ClientScriptListPage = function ClientScriptListPage() {
    const columns = [
      { key: 'name', label: 'Name', render: r => (
        <NameWithDesc name={flat(r.name)} desc={flat(r.description)} />
      )},
      { key: 'table', label: 'Target table', w: 200, render: r => {
        const t = flat(r.table);
        return t ? (
          <a className="mono" style={{ fontSize: 12 }} onClick={(e) => { e.stopPropagation(); window.navigate(`/sn-table/${t}`); }}>{t}</a>
        ) : <span className="muted">—</span>;
      }},
      { key: 'type', label: 'Type', w: 110, render: r => <ClientScriptTypeChip type={flat(r.type) || dv(r, 'type')} /> },
      { key: 'ui_type', label: 'UI type', w: 100, render: r => (
        <span className="mono" style={{ fontSize: 11.5 }}>{flat(r.ui_type) || dv(r, 'ui_type') || '—'}</span>
      )},
      { key: 'active', label: 'Active', w: 80, render: r => (
        isTrue(flat(r.active)) ? <span className="chip green">active</span> : <span className="chip">inactive</span>
      )},
    ];
    return (
      <LogicListShell
        table="sys_script_client"
        title="Client scripts"
        columns={columns}
        searchFields={['name', 'description']}
        extraFilters={[
          { key: 'type', label: 'type', options: [
            { value: 'onLoad', label: 'onLoad' },
            { value: 'onChange', label: 'onChange' },
            { value: 'onSubmit', label: 'onSubmit' },
            { value: 'onCellEdit', label: 'onCellEdit' },
          ]},
        ]}
      />
    );
  };

  // =========================================================================
  // Script includes (sys_script_include)
  // =========================================================================
  window.ScriptIncludeListPage = function ScriptIncludeListPage() {
    const columns = [
      { key: 'name', label: 'Name', render: r => (
        <NameWithDesc name={flat(r.name)} desc={flat(r.description)} />
      )},
      { key: 'api_name', label: 'API name', w: 240, render: r => (
        <span className="mono" style={{ fontSize: 11.5 }}>{flat(r.api_name) || '—'}</span>
      )},
      { key: 'client_callable', label: 'Client-callable', w: 130, render: r => (
        isTrue(flat(r.client_callable)) ? <span className="chip blue">yes</span> : <span className="muted">—</span>
      )},
      { key: 'active', label: 'Active', w: 80, render: r => (
        isTrue(flat(r.active)) ? <span className="chip green">active</span> : <span className="chip">inactive</span>
      )},
    ];
    return (
      <LogicListShell
        table="sys_script_include"
        title="Script includes"
        columns={columns}
        searchFields={['name', 'api_name', 'description']}
      />
    );
  };

  // =========================================================================
  // Scheduled jobs (sysauto_script)
  // =========================================================================
  window.ScheduledJobListPage = function ScheduledJobListPage() {
    const columns = [
      { key: 'name', label: 'Name', render: r => (
        <NameWithDesc name={flat(r.name)} desc={flat(r.description)} />
      )},
      { key: 'run_type', label: 'Run type', w: 130, render: r => (
        <span className="mono" style={{ fontSize: 11.5 }}>{flat(r.run_type) || dv(r, 'run_type') || '—'}</span>
      )},
      { key: 'next_run', label: 'Next run', w: 160, render: r => {
        const s = summarizeSchedule(r);
        return <span style={{ fontSize: 12 }}>{s}</span>;
      }},
      { key: 'conditional', label: 'Conditional', w: 110, render: r => (
        isTrue(flat(r.conditional))
          ? <span style={chip}>yes</span>
          : <span className="muted">—</span>
      )},
      { key: 'active', label: 'Active', w: 80, render: r => (
        isTrue(flat(r.active)) ? <span className="chip green">active</span> : <span className="chip">inactive</span>
      )},
    ];
    return (
      <LogicListShell
        table="sysauto_script"
        title="Scheduled jobs"
        columns={columns}
        searchFields={['name', 'description']}
      />
    );
  };

  // =========================================================================
  // UI policies (sys_ui_policy)
  // =========================================================================
  window.UIPolicyListPage = function UIPolicyListPage() {
    const columns = [
      { key: 'short_description', label: 'Description', render: r => (
        <NameWithDesc name={flat(r.short_description)} desc={flat(r.description)} />
      )},
      { key: 'table', label: 'Target table', w: 220, render: r => {
        const t = flat(r.table) || flat(r.model_table);
        return t ? (
          <a className="mono" style={{ fontSize: 12 }} onClick={(e) => { e.stopPropagation(); window.navigate(`/sn-table/${t}`); }}>{t}</a>
        ) : <span className="muted">—</span>;
      }},
      { key: 'on_load', label: 'On load', w: 90, render: r => (
        isTrue(flat(r.on_load)) ? <span className="chip green">yes</span> : <span className="muted">—</span>
      )},
      { key: 'order', label: 'Order', w: 70, cls: 'num', render: r => (
        <span className="mono">{flat(r.order) ?? '—'}</span>
      )},
      { key: 'active', label: 'Active', w: 80, render: r => (
        isTrue(flat(r.active)) ? <span className="chip green">active</span> : <span className="chip">inactive</span>
      )},
    ];
    return (
      <LogicListShell
        table="sys_ui_policy"
        title="UI policies"
        columns={columns}
        searchFields={['short_description', 'description']}
        defaultOrderBy="short_description"
      />
    );
  };

  // =========================================================================
  // Data policies (sys_data_policy2)
  // =========================================================================
  window.DataPolicyListPage = function DataPolicyListPage() {
    const columns = [
      { key: 'short_description', label: 'Description', render: r => (
        <NameWithDesc name={flat(r.short_description)} desc={flat(r.description)} />
      )},
      { key: 'model_table', label: 'Target table', w: 220, render: r => {
        const t = flat(r.model_table);
        return t ? (
          <a className="mono" style={{ fontSize: 12 }} onClick={(e) => { e.stopPropagation(); window.navigate(`/sn-table/${t}`); }}>{t}</a>
        ) : <span className="muted">—</span>;
      }},
      { key: 'enforce_ui', label: 'Enforce UI', w: 110, render: r => (
        isTrue(flat(r.enforce_ui)) ? <span className="chip blue">yes</span> : <span className="muted">—</span>
      )},
      { key: 'inherit', label: 'Inherit', w: 90, render: r => (
        isTrue(flat(r.inherit)) ? <span style={chip}>yes</span> : <span className="muted">—</span>
      )},
      { key: 'active', label: 'Active', w: 80, render: r => (
        isTrue(flat(r.active)) ? <span className="chip green">active</span> : <span className="chip">inactive</span>
      )},
    ];
    return (
      <LogicListShell
        table="sys_data_policy2"
        title="Data policies"
        columns={columns}
        searchFields={['short_description', 'description']}
        defaultOrderBy="short_description"
      />
    );
  };

  // =========================================================================
  // Scheduled-job "next run" heuristic.
  // =========================================================================
  // ServiceNow stores schedule fields on sysauto_script: run_type, run_period,
  // run_time, run_dayofweek (1=Mon..7=Sun), run_dayofmonth, run_start.
  // We compute a *summary* string and a best-effort next-run datetime,
  // anchored at the snapshot's captured_at so the result is stable across
  // reloads. Day-of-week / day-of-month encoding follows what ServiceNow
  // actually writes; if we get an unrecognized run_type we just return
  // the raw value (the record page will still show the underlying fields).
  function summarizeSchedule(r) {
    const t = String(flat(r.run_type) || dv(r, 'run_type') || '').toLowerCase();
    if (!t) return '—';
    const time = flat(r.run_time) || flat(r.run_start) || '';
    const period = flat(r.run_period) || '';
    if (t === 'daily')   return 'daily' + (time ? ` at ${formatTimeBit(time)}` : '');
    if (t === 'weekly') {
      const d = flat(r.run_dayofweek);
      return 'weekly' + (d ? ` on ${dayName(d)}` : '') + (time ? ` at ${formatTimeBit(time)}` : '');
    }
    if (t === 'monthly') {
      const d = flat(r.run_dayofmonth);
      return 'monthly' + (d ? ` on day ${d}` : '') + (time ? ` at ${formatTimeBit(time)}` : '');
    }
    if (t === 'periodically') return 'every ' + (period ? formatTimeBit(period) : '?');
    if (t === 'once') return 'once' + (time ? ` at ${formatTimeBit(time)}` : '');
    if (t === 'on_demand') return 'on demand';
    if (t === 'business_calendar') return 'business calendar';
    return t;
  }
  function formatTimeBit(s) {
    if (!s) return '';
    const str = String(s);
    // ServiceNow stores time-of-day as "1970-01-01 HH:MM:SS" or just "HH:MM:SS".
    const m = str.match(/(\d{2}:\d{2})(?::\d{2})?$/);
    return m ? m[1] : str.split(' ').pop();
  }
  function dayName(d) {
    const n = parseInt(d, 10);
    const names = ['?', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    return names[n] || String(d);
  }

  // Heuristic next-run datetime, anchored at the snapshot captured_at.
  // Returns a JS Date or null. We deliberately don't try to handle all
  // ServiceNow edge cases (business calendars, multiple periods); the
  // summary string above is the authoritative human-readable view.
  function nextRunAfter(r, anchor) {
    const t = String(flat(r.run_type) || dv(r, 'run_type') || '').toLowerCase();
    const timeBit = formatTimeBit(flat(r.run_time) || flat(r.run_start) || '');
    const [hh, mm] = (timeBit.split(':').map(s => parseInt(s, 10)));
    if (isNaN(hh) || isNaN(mm)) return null;
    const setTime = (d) => { d.setHours(hh, mm, 0, 0); return d; };
    // ServiceNow timestamps are space-separated ("2026-04-28 06:12:33").
    // Convert to ISO so Safari and old engines don't return Invalid Date.
    const d0 = new Date(String(anchor || '').replace(' ', 'T'));
    if (isNaN(d0.getTime())) return null;
    if (t === 'daily') {
      let d = setTime(new Date(d0));
      if (d <= d0) d.setDate(d.getDate() + 1);
      return d;
    }
    if (t === 'weekly') {
      const dow = parseInt(flat(r.run_dayofweek), 10);
      if (isNaN(dow)) return null;
      let d = setTime(new Date(d0));
      // ServiceNow: 1=Mon..7=Sun. JS getDay(): 0=Sun..6=Sat. Convert.
      const jsTarget = dow === 7 ? 0 : dow;
      while (d.getDay() !== jsTarget || d <= d0) d.setDate(d.getDate() + 1);
      return d;
    }
    if (t === 'monthly') {
      const dom = parseInt(flat(r.run_dayofmonth), 10);
      if (isNaN(dom)) return null;
      let d = setTime(new Date(d0));
      d.setDate(dom);
      if (d <= d0) d.setMonth(d.getMonth() + 1);
      return d;
    }
    return null;
  }

  // =========================================================================
  // Business rule record
  // =========================================================================
  window.BusinessRuleRecordPage = function BusinessRuleRecordPage({ sys_id }) {
    return <ScriptRecordView table="sys_script" sys_id={sys_id}
      title={r => flat(r.name) || '(unnamed)'}
      crumbs={[{ label: 'Logic', href: '/logic' }, { label: 'Business rules', href: '/business-rules' }]}
      tableField="collection"
      extraChips={r => [
        <WhenChip key="when" when={flat(r.when) || dv(r, 'when')} />,
        <span key="order" style={chip}>order {flat(r.order) ?? '—'}</span>,
      ]}
      detailFields={r => [
        ['Name', flat(r.name)],
        ['Target table', flat(r.collection)],
        ['When', flat(r.when) || dv(r, 'when')],
        ['Order', flat(r.order) ?? '—'],
        ['Priority', flat(r.priority) ?? '—'],
        ['Active', isTrue(flat(r.active)) ? 'true' : 'false'],
        ['Add message', flat(r.add_message) ? 'true' : 'false'],
        ['Abort action', flat(r.abort_action) ? 'true' : 'false'],
        ['Created', flat(r.sys_created_on), 'by ' + (flat(r.sys_created_by) || '—')],
        ['Updated', flat(r.sys_updated_on), 'by ' + (flat(r.sys_updated_by) || '—')],
      ]}
      conditionField="filter_condition"
    />;
  };

  // =========================================================================
  // Client script record
  // =========================================================================
  window.ClientScriptRecordPage = function ClientScriptRecordPage({ sys_id }) {
    return <ScriptRecordView table="sys_script_client" sys_id={sys_id}
      title={r => flat(r.name) || '(unnamed)'}
      crumbs={[{ label: 'Logic', href: '/logic' }, { label: 'Client scripts', href: '/client-scripts' }]}
      tableField="table"
      extraChips={r => [
        <ClientScriptTypeChip key="type" type={flat(r.type) || dv(r, 'type')} />,
        <span key="ui" style={chip}>{flat(r.ui_type) || dv(r, 'ui_type') || 'ui'}</span>,
      ]}
      detailFields={r => [
        ['Name', flat(r.name)],
        ['Target table', flat(r.table)],
        ['Type', flat(r.type) || dv(r, 'type')],
        ['UI type', flat(r.ui_type) || dv(r, 'ui_type') || '—'],
        ['Field', flat(r.field_name) || dv(r, 'field_name') || '—'],
        ['Applies to extensions', isTrue(flat(r.applies_extension)) ? 'true' : 'false'],
        ['Active', isTrue(flat(r.active)) ? 'true' : 'false'],
        ['Created', flat(r.sys_created_on), 'by ' + (flat(r.sys_created_by) || '—')],
        ['Updated', flat(r.sys_updated_on), 'by ' + (flat(r.sys_updated_by) || '—')],
      ]}
      conditionField={null}
    />;
  };

  // =========================================================================
  // Script include record
  // =========================================================================
  window.ScriptIncludeRecordPage = function ScriptIncludeRecordPage({ sys_id }) {
    const [rec, setRec] = useState(null);
    const [referenced, setReferenced] = useState(null);
    useEffect(() => {
      let cancel = false;
      setRec(null); setReferenced(null);
      L.fetchRecord('sys_script_include', sys_id).then(r => {
        if (cancel) return;
        if (!r) { setRec(false); return; }
        setRec(r);
        window.AuditLog.push('view', `sys_script_include/${flat(r.name) || sys_id.slice(0, 8)}`, flat(r.name) || '');
        // Exact-reference list via the session-cached reverse index. The
        // index pages every BR / CS / SJ once per session, scans bodies
        // with the word-boundary regex, and persists the result. First
        // include view pays the build; subsequent views read from memory.
        L.getReverseIncludeIndex().then(idx => {
          if (cancel) return;
          const refs = idx.byId.get(sys_id) || [];
          setReferenced({
            refs,
            missing: idx.missing,
          });
        }).catch(() => { if (!cancel) setReferenced({ refs: [], missing: {} }); });
      }).catch(() => { if (!cancel) setRec(false); });
      return () => { cancel = true; };
    }, [sys_id]);

    if (rec === null) return <div className="empty"><div className="dot-pulse" style={{ marginBottom: 12 }} />loading script include…</div>;
    if (rec === false) return <div className="empty"><div className="glyph"><window.Icon name="info" /></div>Script include not in snapshot.</div>;

    const name = flat(rec.name) || '(unnamed)';
    const api  = flat(rec.api_name) || '';
    const desc = flat(rec.description) || '';
    const script = flat(rec.script) || '';
    const active = isTrue(flat(rec.active));

    return (
      <div className="record">
        <div className="left">
          <div className="record-header">
            <div className="crumbs">
              <a onClick={() => window.navigate('/logic')}>Logic</a>
              <window.Icon name="chevron_right" size={11} />
              <a onClick={() => window.navigate('/script-includes')}>Script includes</a>
              <window.Icon name="chevron_right" size={11} />
              <span className="mono">{name}</span>
            </div>
            <h1>
              <window.Icon name="book" size={22} />
              <span style={{ flex: 1, minWidth: 0 }}>{name}</span>
            </h1>
            <div className="title-row">
              {active ? <span className="chip green">active</span> : <span className="chip">inactive</span>}
              {isTrue(flat(rec.client_callable)) && <span className="chip blue">client-callable</span>}
              {api && <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{api}</span>}
              <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--fg-4)' }}>
                sys_id {sys_id.slice(0, 8)}…
              </span>
            </div>
          </div>

          {desc && (
            <div className="section">
              <h3>Description</h3>
              <div style={{ fontSize: 12.5, color: 'var(--fg-2)', whiteSpace: 'pre-wrap' }}>{desc}</div>
            </div>
          )}

          <div className="section">
            <h3>Include details</h3>
            <div className="fields" style={{ display: 'grid', gridTemplateColumns: '180px 1fr', rowGap: 8, columnGap: 16 }}>
              <Field label="Name">{name}</Field>
              <Field label="API name">{api || '—'}</Field>
              <Field label="Active">{active ? 'true' : 'false'}</Field>
              <Field label="Client-callable">{isTrue(flat(rec.client_callable)) ? 'true' : 'false'}</Field>
              <Field label="Access">{flat(rec.access) || '—'}</Field>
              <Field label="Created">{flat(rec.sys_created_on) || '—'} <span style={{ color: 'var(--fg-4)' }}>by {flat(rec.sys_created_by) || '—'}</span></Field>
              <Field label="Updated">{flat(rec.sys_updated_on) || '—'} <span style={{ color: 'var(--fg-4)' }}>by {flat(rec.sys_updated_by) || '—'}</span></Field>
            </div>
          </div>

          <div className="section">
            <h3>Script</h3>
            {script ? <CodeBlock maxHeight={600}>{script}</CodeBlock> : <Empty text="No script body on this include." />}
          </div>

          <ManifestFooter />
        </div>

        <div className="right">
          <div className="section" style={{ padding: '12px 14px' }}>
            <h3 style={{ marginBottom: 8 }}>Referenced by</h3>
            {referenced == null ? (
              <div style={{ color: 'var(--fg-4)', fontSize: 12, lineHeight: 1.55 }}>
                <span className="dot-pulse" style={{ display: 'inline-block', marginRight: 8 }} />
                Scanning script bodies (one-time per session)…
              </div>
            ) : (() => {
              const byTable = { sys_script: [], sys_script_client: [], sysauto_script: [] };
              for (const r of referenced.refs) byTable[r.table].push(r);
              const tiles = [
                ['Business rules',  'sys_script',        '/business-rules'],
                ['Client scripts',  'sys_script_client', '/client-scripts'],
                ['Scheduled jobs',  'sysauto_script',    '/scheduled-jobs'],
              ];
              return (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
                    {tiles.map(([k, t]) => {
                      const miss = referenced.missing && referenced.missing[t];
                      return (
                        <div key={t} style={{
                          background: 'var(--bg-elev)', border: '1px solid var(--border)',
                          borderRadius: 6, padding: '6px 8px',
                        }}>
                          <div style={{ fontSize: 10, color: 'var(--fg-3)' }}>{k}</div>
                          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14 }}>
                            {miss ? '—' : byTable[t].length.toLocaleString()}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {referenced.refs.length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      {tiles.map(([k, t, url]) => byTable[t].length > 0 && (
                        <div key={t} style={{ marginBottom: 10 }}>
                          <div style={{ fontSize: 11, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 4 }}>
                            {k}
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            {byTable[t].slice(0, 30).map(r => (
                              <div key={r.sys_id}
                                   onClick={() => window.navigate(`${url}/${r.sys_id}`)}
                                   style={{
                                     padding: '4px 8px', cursor: 'pointer',
                                     borderRadius: 4, fontSize: 12,
                                     background: 'var(--bg-elev)', border: '1px solid var(--border)',
                                   }}>
                                {r.name}
                              </div>
                            ))}
                            {byTable[t].length > 30 && (
                              <div style={{ fontSize: 11, color: 'var(--fg-4)', textAlign: 'center', padding: '4px 0' }}>
                                + {byTable[t].length - 30} more
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {referenced.refs.length === 0 && (
                    <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--fg-4)', fontStyle: 'italic' }}>
                      No scripts in the snapshot reference this include.
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      </div>
    );
  };

  // =========================================================================
  // Scheduled job record
  // =========================================================================
  window.ScheduledJobRecordPage = function ScheduledJobRecordPage({ sys_id }) {
    const [rec, setRec] = useState(null);
    const [includes, setIncludes] = useState(null);
    useEffect(() => {
      let cancel = false;
      setRec(null); setIncludes(null);
      L.fetchRecord('sysauto_script', sys_id).then(r => {
        if (cancel) return;
        if (!r) { setRec(false); return; }
        setRec(r);
        window.AuditLog.push('view', `sysauto_script/${flat(r.name) || sys_id.slice(0, 8)}`, flat(r.name) || '');
        L.getIncludeIndex().then(idx => {
          if (cancel) return;
          setIncludes(L.scanForIncludes(flat(r.script) || '', idx));
        });
      }).catch(() => { if (!cancel) setRec(false); });
      return () => { cancel = true; };
    }, [sys_id]);

    if (rec === null) return <div className="empty"><div className="dot-pulse" style={{ marginBottom: 12 }} />loading scheduled job…</div>;
    if (rec === false) return <div className="empty"><div className="glyph"><window.Icon name="info" /></div>Scheduled job not in snapshot.</div>;

    const name = flat(rec.name) || '(unnamed)';
    const desc = flat(rec.description) || '';
    const script = flat(rec.script) || '';
    const active = isTrue(flat(rec.active));
    const summary = summarizeSchedule(rec);
    const anchor = data?.manifest?.captured_at;
    const next = anchor ? nextRunAfter(rec, anchor) : null;

    return (
      <div className="record">
        <div className="left">
          <div className="record-header">
            <div className="crumbs">
              <a onClick={() => window.navigate('/logic')}>Logic</a>
              <window.Icon name="chevron_right" size={11} />
              <a onClick={() => window.navigate('/scheduled-jobs')}>Scheduled jobs</a>
              <window.Icon name="chevron_right" size={11} />
              <span className="mono">{name}</span>
            </div>
            <h1>
              <window.Icon name="history" size={22} />
              <span style={{ flex: 1, minWidth: 0 }}>{name}</span>
            </h1>
            <div className="title-row">
              {active ? <span className="chip green">active</span> : <span className="chip">inactive</span>}
              <span style={chip}>{summary}</span>
              {isTrue(flat(rec.conditional)) && <span style={chip}>conditional</span>}
              <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--fg-4)' }}>
                sys_id {sys_id.slice(0, 8)}…
              </span>
            </div>
          </div>

          {desc && (
            <div className="section">
              <h3>Description</h3>
              <div style={{ fontSize: 12.5, color: 'var(--fg-2)', whiteSpace: 'pre-wrap' }}>{desc}</div>
            </div>
          )}

          <div className="section">
            <h3>Schedule</h3>
            <div className="fields" style={{ display: 'grid', gridTemplateColumns: '180px 1fr', rowGap: 8, columnGap: 16 }}>
              <Field label="Run type">{flat(rec.run_type) || dv(rec, 'run_type') || '—'}</Field>
              <Field label="Run time">{flat(rec.run_time) || '—'}</Field>
              <Field label="Run period">{flat(rec.run_period) || '—'}</Field>
              <Field label="Run day of week">{flat(rec.run_dayofweek) ? dayName(flat(rec.run_dayofweek)) : '—'}</Field>
              <Field label="Run day of month">{flat(rec.run_dayofmonth) || '—'}</Field>
              <Field label="Run start">{flat(rec.run_start) || '—'}</Field>
              <Field label="Summary">{summary}</Field>
              <Field label="Next run (estimated)">
                {next ? next.toISOString().replace('T', ' ').slice(0, 19) :
                  <span style={{ color: 'var(--fg-4)', fontStyle: 'italic' }}>not derivable from run_type {flat(rec.run_type) || '—'}</span>}
                {next && anchor && (
                  <span style={{ color: 'var(--fg-4)', marginLeft: 8, fontSize: 11 }}>
                    relative to snapshot {anchor}
                  </span>
                )}
              </Field>
              <Field label="Conditional">{isTrue(flat(rec.conditional)) ? 'true' : 'false'}</Field>
              <Field label="Active">{active ? 'true' : 'false'}</Field>
            </div>
          </div>

          {flat(rec.condition) && (
            <div className="section">
              <h3>Condition</h3>
              <CodeBlock maxHeight={140}>{flat(rec.condition)}</CodeBlock>
            </div>
          )}

          <div className="section">
            <h3>Script</h3>
            {script ? <CodeBlock maxHeight={600}>{script}</CodeBlock> : <Empty text="No script body on this scheduled job." />}
          </div>

          <IncludeRefsSection includes={includes} />

          <ManifestFooter />
        </div>
      </div>
    );
  };

  // =========================================================================
  // Generic record view for sys_script and sys_script_client.
  // Renders the same crumbs / chips / detail-grid / script body /
  // condition / "Script includes referenced" pattern.
  // =========================================================================
  function ScriptRecordView({ table, sys_id, title, crumbs, tableField, extraChips, detailFields, conditionField }) {
    const [rec, setRec] = useState(null);
    const [includes, setIncludes] = useState(null);
    useEffect(() => {
      let cancel = false;
      setRec(null); setIncludes(null);
      L.fetchRecord(table, sys_id).then(r => {
        if (cancel) return;
        if (!r) { setRec(false); return; }
        setRec(r);
        window.AuditLog.push('view', `${table}/${flat(r.name) || sys_id.slice(0, 8)}`, flat(r.name) || '');
        L.getIncludeIndex().then(idx => {
          if (cancel) return;
          setIncludes(L.scanForIncludes(flat(r.script) || '', idx));
        });
      }).catch(() => { if (!cancel) setRec(false); });
      return () => { cancel = true; };
    }, [table, sys_id]);

    if (rec === null) return <div className="empty"><div className="dot-pulse" style={{ marginBottom: 12 }} />loading {table}…</div>;
    if (rec === false) return <div className="empty"><div className="glyph"><window.Icon name="info" /></div>Record not in snapshot.</div>;

    const name = title(rec);
    const script = flat(rec.script) || '';
    const active = isTrue(flat(rec.active));
    const targetTable = tableField ? flat(rec[tableField]) : null;

    return (
      <div className="record">
        <div className="left">
          <div className="record-header">
            <div className="crumbs">
              {crumbs.map((c, i) => (
                <React.Fragment key={i}>
                  <a onClick={() => window.navigate(c.href)}>{c.label}</a>
                  <window.Icon name="chevron_right" size={11} />
                </React.Fragment>
              ))}
              <span className="mono">{name}</span>
            </div>
            <h1>
              <window.Icon name="flag" size={22} />
              <span style={{ flex: 1, minWidth: 0 }}>{name}</span>
            </h1>
            <div className="title-row">
              {active ? <span className="chip green">active</span> : <span className="chip">inactive</span>}
              {(extraChips ? extraChips(rec) : null)}
              {targetTable && <>
                <span className="dot">·</span>
                <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>runs on</span>
                <TableCrumb name={targetTable} />
              </>}
              <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--fg-4)' }}>
                sys_id {sys_id.slice(0, 8)}…
              </span>
            </div>
          </div>

          <div className="section">
            <h3>Record details</h3>
            <div className="fields" style={{ display: 'grid', gridTemplateColumns: '180px 1fr', rowGap: 8, columnGap: 16 }}>
              {detailFields(rec).map(([label, value, trail]) => (
                <Field key={label} label={label}>
                  {(value == null || value === '') ? '—' : value}
                  {trail && <span style={{ color: 'var(--fg-4)', marginLeft: 8 }}>{trail}</span>}
                </Field>
              ))}
            </div>
          </div>

          {conditionField && flat(rec[conditionField]) && (
            <div className="section">
              <h3>Filter condition</h3>
              <CodeBlock maxHeight={140}>{flat(rec[conditionField])}</CodeBlock>
            </div>
          )}

          <div className="section">
            <h3>Script</h3>
            {script ? <CodeBlock maxHeight={600}>{script}</CodeBlock> : <Empty text="No script body on this record." />}
          </div>

          <IncludeRefsSection includes={includes} />

          <ManifestFooter />
        </div>
      </div>
    );
  }

  function IncludeRefsSection({ includes }) {
    if (includes === null) return null;
    if (!includes.length) return null;
    return (
      <div className="section">
        <h3>Script includes referenced</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {includes.map(inc => (
            <span key={inc.sys_id}
                  onClick={() => window.navigate(`/script-includes/${inc.sys_id}`)}
                  style={{
                    ...chip,
                    background: 'var(--c-blue-bg)',
                    borderColor: 'var(--c-blue-border)',
                    color: 'var(--c-blue)',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11.5,
                  }}>
              {inc.name}
              {inc.api_name && inc.api_name !== inc.name && (
                <span style={{ color: 'var(--fg-4)', marginLeft: 4 }}>{inc.api_name}</span>
              )}
            </span>
          ))}
        </div>
      </div>
    );
  }

  function ManifestFooter() {
    const m = data?.manifest || {};
    const tag = [m.snapshot_date, m.label].filter(Boolean).join(' ') || 'unlabeled snapshot';
    return (
      <div className="section" style={{ borderBottom: 'none', color: 'var(--fg-4)', fontSize: 11.5, paddingTop: 14, paddingBottom: 30 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)' }}>
          <window.Icon name="archive" size={11} />
          <span>archived from snapshot {tag}</span>
        </div>
      </div>
    );
  }

  // =========================================================================
  // Per-table logic inspector — /sn-table/:name
  // =========================================================================
  // Given a ServiceNow table name, show every piece of logic that runs on
  // it: business rules (collection = name), client scripts (table = name),
  // UI policies (table = name OR model_table = name, merged), data
  // policies (model_table = name), and data policy rules (table = name).
  // Each tab gets a count + counter chip; tabs whose backing table isn't
  // in the snapshot render NotInSnapshot.
  // Build a structured markdown prompt of every active rule on a table.
  // Designed to be pasted into an LLM with the instruction at the top —
  // gives the model a single document to reason about table behavior
  // from. Inactive rules are excluded (per the "Active table logic"
  // request); each script is included in full so the model can spot
  // cross-rule interactions. Order matches ServiceNow's runtime priority
  // where the field is populated (lower `order` runs first).
  //
  // UI policies pair with their actions (joined by sys_ui_policy_action.
  // ui_policy = policy.sys_id), and data policies pair with their rules
  // (sys_data_policy_rule.sys_data_policy = policy.sys_id), so the model
  // sees what each policy actually changes — not just that it exists.
  function buildLogicPrompt(tableName, d) {
    const activeRows = (env) => (env?.rows || [])
      .filter(r => isTrue(r.active) || r.active == null);
    const byOrder = (a, b) => {
      const ao = Number(a.order || a.priority || 9999);
      const bo = Number(b.order || b.priority || 9999);
      if (ao !== bo) return ao - bo;
      return String(a.name || a.short_description || '').localeCompare(String(b.name || b.short_description || ''));
    };
    const code = (s) => '```javascript\n' + (s == null ? '' : String(s)) + '\n```';
    const fenceText = (s) => '```\n' + (s == null ? '' : String(s)) + '\n```';

    const br = activeRows(d.br).slice().sort(byOrder);
    const cs = activeRows(d.cs).slice().sort(byOrder);
    const uip = activeRows(d.uip).slice().sort(byOrder);
    const uipa = (d.uipa?.rows || []);                              // actions can be inactive on an active policy; include all
    const dp = activeRows(d.dp).slice().sort(byOrder);
    const dpr = (d.dpr?.rows || []);

    const actionsByPolicy = new Map();
    for (const a of uipa) {
      const pid = a.ui_policy;
      if (!pid) continue;
      if (!actionsByPolicy.has(pid)) actionsByPolicy.set(pid, []);
      actionsByPolicy.get(pid).push(a);
    }
    const rulesByPolicy = new Map();
    for (const r of dpr) {
      const pid = r.sys_data_policy;
      if (!pid) continue;
      if (!rulesByPolicy.has(pid)) rulesByPolicy.set(pid, []);
      rulesByPolicy.get(pid).push(r);
    }

    const lines = [];
    const push = (s) => lines.push(s == null ? '' : String(s));

    push(`You are a senior ServiceNow architect. Below is every active piece of server-side and client-side logic that runs against the table \`${tableName}\` on a real ServiceNow instance, extracted from a read-only snapshot of the production system.

Please carefully read and reason about every rule below — execution order, conditions, and interactions between rules matter. Then reply with a plain-English explanation covering:

1. **What the table represents** — the entity it models and the workflows it supports, inferred from the logic running against it.
2. **Per-field behavior** — for each field that any rule touches, describe what changes its value, what hides/shows it, what makes it mandatory or read-only, and under which conditions.
3. **Cross-rule interactions** — non-obvious places where rules combine, supersede, or fight each other (a UI policy hiding what a business rule populates, an async rule racing a before rule, etc.).
4. **Risks and oddities** — rules that look like dead code, conditions that can never fire, debug logging left in place, conflicts between data policies and business rules.

Be specific. Cite rule names. If you cannot tell from the script alone what a rule does (e.g. it calls a script include not included here), say so explicitly.

---

## Table

\`${tableName}\`

---

## Business rules — ${br.length} active`);

    for (const r of br) {
      push('');
      const meta = [
        `order=${r.order ?? r.priority ?? '?'}`,
        r.when ? `when=${r.when}` : null,
        isTrue(r.action_insert) ? 'on_insert' : null,
        isTrue(r.action_update) ? 'on_update' : null,
        isTrue(r.action_delete) ? 'on_delete' : null,
        isTrue(r.action_query)  ? 'on_query'  : null,
      ].filter(Boolean).join(', ');
      push(`### "${r.name || '(unnamed)'}" — ${meta}`);
      if (r.condition)        push(`Condition: \`${r.condition}\``);
      if (r.filter_condition) push(`Filter (encoded query): \`${r.filter_condition}\``);
      if (r.role_conditions)  push(`Role gate: \`${r.role_conditions}\``);
      if (r.description)      push(`Description: ${r.description}`);
      push(code(r.script || ''));
    }

    push('');
    push(`## Client scripts — ${cs.length} active`);
    for (const r of cs) {
      push('');
      const meta = [
        r.type ? `type=${r.type}` : null,
        r.ui_type ? `ui_type=${r.ui_type}` : null,
        r.field_name ? `field=${r.field_name}` : null,
      ].filter(Boolean).join(', ');
      push(`### "${r.name || '(unnamed)'}" — ${meta}`);
      if (r.condition)   push(`Condition: \`${r.condition}\``);
      if (r.description) push(`Description: ${r.description}`);
      push(code(r.script || ''));
    }

    push('');
    push(`## UI policies — ${uip.length} active`);
    for (const p of uip) {
      push('');
      const meta = [
        p.order != null ? `order=${p.order}` : null,
        isTrue(p.run_scripts)      ? 'run_scripts=true'      : null,
        isTrue(p.reverse_if_false) ? 'reverse_if_false=true' : null,
        isTrue(p.on_load)          ? 'on_load=true'          : null,
      ].filter(Boolean).join(', ');
      push(`### "${p.short_description || '(no description)'}" — ${meta}`);
      if (p.conditions) push(`Conditions (encoded query): \`${p.conditions}\``);
      const acts = actionsByPolicy.get(p.sys_id) || [];
      if (acts.length) {
        push('');
        push('Actions:');
        for (const a of acts) {
          const triplet = [
            a.field || '?',
            `visible=${a.visible ?? 'ignore'}`,
            `mandatory=${a.mandatory ?? 'ignore'}`,
            `disabled=${a.disabled ?? 'ignore'}`,
          ].join(', ');
          push(`- ${triplet}`);
        }
      }
      if (p.script_true) {
        push('');
        push('Script when condition true:');
        push(code(p.script_true));
      }
      if (p.script_false) {
        push('');
        push('Script when condition false:');
        push(code(p.script_false));
      }
    }

    push('');
    push(`## Data policies — ${dp.length} active`);
    for (const p of dp) {
      push('');
      push(`### "${p.short_description || '(no description)'}"`);
      if (p.conditions) push(`Conditions: \`${p.conditions}\``);
      if (p.description) push(`Description: ${p.description}`);
      const rules = rulesByPolicy.get(p.sys_id) || [];
      if (rules.length) {
        push('');
        push('Rules:');
        for (const r of rules) {
          push(`- field=\`${r.field || '?'}\`: mandatory=${r.mandatory ?? 'ignore'}, disabled=${r.disabled ?? 'ignore'}`);
        }
      }
    }

    return lines.join('\n') + '\n';
  }

  window.SnTableInspectorPage = function SnTableInspectorPage({ name }) {
    const [tab, setTab] = useState('br');
    const [d, setD] = useState({});
    // Track which table backs each tab so NotInSnapshot can be honest.
    const TABS = useMemo(() => [
      { id: 'br',   label: 'Business rules',     table: 'sys_script',           filters: { collection: name }, columns: 'br' },
      { id: 'cs',   label: 'Client scripts',     table: 'sys_script_client',    filters: { table: name },      columns: 'cs' },
      { id: 'uip',  label: 'UI policies',        table: 'sys_ui_policy',                                       columns: 'uip', special: 'uip' },
      { id: 'uipa', label: 'UI policy actions',  table: 'sys_ui_policy_action', filters: { table: name },      columns: 'uipa' },
      { id: 'dp',   label: 'Data policies',      table: 'sys_data_policy2',     filters: { model_table: name }, columns: 'dp' },
      { id: 'dpr',  label: 'Data policy rules',  table: 'sys_data_policy_rule', filters: { table: name },      columns: 'dpr' },
    ], [name]);

    useEffect(() => {
      let cancel = false;
      setD({});
      window.AuditLog.push('view', `sn-table/${name}`, `Logic on ${name}`);
      for (const t of TABS) {
        const set = (val) => { if (!cancel) setD(prev => ({ ...prev, [t.id]: val })); };
        if (t.special === 'uip') {
          // sys_ui_policy splits its target table across two columns
          // (table and model_table); some forms use one, some the other.
          // Run both and merge — de-dupe by sys_id.
          Promise.all([
            L.fetchTable('sys_ui_policy', { limit: 500, filters: { table: name }, order_by: 'short_description', dir: 'asc' }),
            L.fetchTable('sys_ui_policy', { limit: 500, filters: { model_table: name }, order_by: 'short_description', dir: 'asc' }),
          ]).then(([a, b]) => {
            if (a.missing && b.missing) { set({ rows: [], total: 0, missing: true }); return; }
            const seen = new Map();
            for (const r of [...(a.rows || []), ...(b.rows || [])]) if (r.sys_id && !seen.has(r.sys_id)) seen.set(r.sys_id, r);
            const rows = [...seen.values()];
            set({ rows, total: rows.length, missing: false });
          });
        } else {
          L.fetchTable(t.table, { limit: 500, filters: t.filters, order_by: 'name', dir: 'asc' })
            .then(set)
            .catch(() => set({ rows: [], total: 0, missing: true }));
        }
      }
      return () => { cancel = true; };
    }, [TABS, name]);

    const r = (id) => d[id] || { rows: [], total: 0, loading: true };

    return (
      <div className="record">
        <div className="left">
          <div className="record-header">
            <div className="crumbs">
              <a onClick={() => window.navigate('/logic')}>Logic</a>
              <window.Icon name="chevron_right" size={11} />
              <span>Table inspector</span>
              <window.Icon name="chevron_right" size={11} />
              <span className="mono">{name}</span>
            </div>
            <h1>
              <window.Icon name="db" size={22} />
              <span style={{ flex: 1, minWidth: 0 }}>
                Logic on <span className="mono">{name}</span>
              </span>
            </h1>
            <div className="title-row">
              <span style={chip}>{r('br').total ?? 0} business rules</span>
              <span style={chip}>{r('cs').total ?? 0} client scripts</span>
              <span style={chip}>{r('uip').total ?? 0} UI policies</span>
              <span style={chip}>{r('dp').total ?? 0} data policies</span>
              <CopyLlmPromptButton name={name} d={d} />
            </div>
          </div>

          <div className="section">
            <InspectorTabs tabs={TABS} active={tab} onChange={setTab} totals={d} />
            <div style={{ paddingTop: 8 }}>
              {tab === 'br'   && <InspectorRows r={r('br')}   columns="br"   table="sys_script" />}
              {tab === 'cs'   && <InspectorRows r={r('cs')}   columns="cs"   table="sys_script_client" />}
              {tab === 'uip'  && <InspectorRows r={r('uip')}  columns="uip"  table="sys_ui_policy" />}
              {tab === 'uipa' && <InspectorRows r={r('uipa')} columns="uipa" table="sys_ui_policy_action" />}
              {tab === 'dp'   && <InspectorRows r={r('dp')}   columns="dp"   table="sys_data_policy2" />}
              {tab === 'dpr'  && <InspectorRows r={r('dpr')}  columns="dpr"  table="sys_data_policy_rule" />}
            </div>
          </div>

          <ManifestFooter />
        </div>
      </div>
    );
  };

  // "Copy LLM prompt" — assembles a markdown prompt of every active rule
  // currently loaded into the inspector and writes it to the clipboard.
  // Disabled until at least the BR/CS/UIP/DP tabs have settled, so the
  // user doesn't paste a partial snapshot into the model and miss half
  // the table's behavior.
  // Total prompt-size cap. Anything past this is dropped with an
  // explicit truncation marker — most LLMs accept multi-hundred-KB
  // pastes, but very deep call graphs (Script Include A calls B calls C…)
  // can balloon when the table has many BRs. 600 KB ≈ 150K tokens, safe
  // for Claude / GPT-4o / Gemini 1.5 context windows.
  const PROMPT_BUDGET_BYTES = 600 * 1024;

  // Walk script bodies → directly-referenced sys_script_includes →
  // bodies of those includes → further includes they reference, etc.
  // Returns ordered, deduped, depth-1-first list of include records,
  // each as { sys_id, name, api_name, description, script, depth,
  // referrers: Set<sys_id_of_caller> }. Cycles are broken by the seen
  // set so a self-referential include doesn't loop forever.
  async function gatherCascadedIncludes(seedScripts) {
    const includes = await L.getIncludeIndex();
    if (!includes.length) return [];
    const collected = new Map();   // sys_id → { record, depth, referrers }
    const queue = [];              // [{ from_label, body, depth }]
    for (const seed of seedScripts) {
      queue.push({ body: seed.body, from_label: seed.label, depth: 0 });
    }
    while (queue.length) {
      const { body, depth } = queue.shift();
      if (!body) continue;
      const hits = L.scanForIncludes(body, includes);
      for (const inc of hits) {
        if (collected.has(inc.sys_id)) continue;   // already gathered
        collected.set(inc.sys_id, { stub: inc, depth: depth + 1, record: null });
      }
    }
    // Fetch the bodies of all gathered includes in parallel.
    const ids = [...collected.keys()];
    const records = await Promise.all(ids.map(sid =>
      data.fetchRecord('sys_script_include', sid).catch(() => null)
    ));
    for (let i = 0; i < ids.length; i++) {
      const c = collected.get(ids[i]);
      c.record = records[i];
    }
    // Now do the cascade rounds. Each round scans the bodies of the
    // includes we just fetched and adds any new transitive includes.
    let frontier = ids.slice();
    while (frontier.length) {
      const next = [];
      for (const sid of frontier) {
        const c = collected.get(sid);
        if (!c || !c.record) continue;
        const body = (c.record.script && c.record.script.value) || c.record.script || '';
        if (!body) continue;
        const hits = L.scanForIncludes(String(body), includes);
        for (const inc of hits) {
          if (collected.has(inc.sys_id)) continue;
          collected.set(inc.sys_id, { stub: inc, depth: c.depth + 1, record: null });
          next.push(inc.sys_id);
        }
      }
      if (!next.length) break;
      const recs = await Promise.all(next.map(sid =>
        data.fetchRecord('sys_script_include', sid).catch(() => null)
      ));
      for (let i = 0; i < next.length; i++) {
        collected.get(next[i]).record = recs[i];
      }
      frontier = next;
    }
    // Sort by depth ascending (closest references first), then by name.
    return [...collected.values()]
      .filter(c => c.record)
      .sort((a, b) => {
        if (a.depth !== b.depth) return a.depth - b.depth;
        const an = (a.record.name && a.record.name.value) || a.record.name || '';
        const bn = (b.record.name && b.record.name.value) || b.record.name || '';
        return String(an).localeCompare(String(bn));
      });
  }

  // Format the cascaded includes as a markdown section to append to
  // the base prompt. Each include is fenced as JavaScript. If we hit
  // the size budget mid-section, emit a truncation marker that names
  // the includes that were skipped so the LLM can be honest about
  // what it's missing.
  function renderIncludesSection(cascaded, alreadyUsed) {
    if (!cascaded.length) return '\n## Referenced script includes — 0 (transitive)\n';
    const fence = (s) => '```javascript\n' + (s == null ? '' : String(s)) + '\n```';
    const parts = [`\n## Referenced script includes — ${cascaded.length} (transitive, depth-sorted)\n`];
    let used = alreadyUsed;
    let truncatedAt = -1;
    for (let i = 0; i < cascaded.length; i++) {
      const c = cascaded[i];
      const rec = c.record;
      const get = (k) => (rec[k] && rec[k].value !== undefined) ? rec[k].value : rec[k];
      const name = get('name') || '(unnamed)';
      const api = get('api_name') || '';
      const desc = get('description') || '';
      const script = get('script') || '';
      const block =
        `\n### "${name}"${api ? ` · \`${api}\`` : ''} — depth ${c.depth}\n` +
        (desc ? `Description: ${desc}\n` : '') +
        fence(script) + '\n';
      if (used + block.length > PROMPT_BUDGET_BYTES) {
        truncatedAt = i;
        break;
      }
      parts.push(block);
      used += block.length;
    }
    if (truncatedAt >= 0) {
      const remaining = cascaded.slice(truncatedAt);
      const names = remaining.slice(0, 25).map(c => {
        const rec = c.record;
        const get = (k) => (rec[k] && rec[k].value !== undefined) ? rec[k].value : rec[k];
        return `${get('name')} (depth ${c.depth})`;
      }).join(', ');
      parts.push(
        `\n<!-- TRUNCATED: ${remaining.length} more script include(s) omitted to keep ` +
        `the prompt under ${Math.round(PROMPT_BUDGET_BYTES/1024)} KB. ` +
        `Omitted: ${names}${remaining.length > 25 ? ', …' : ''} -->\n`
      );
    }
    return parts.join('');
  }

  // Collect every script body in scope on the current table so the
  // cascade walker can scan them. Returns [{ label, body }].
  //
  // Includes the rule body but also the advanced `condition` and
  // `filter_condition` fields: ServiceNow lets a rule put JavaScript
  // there (`new MyUtil().shouldRun(current)`) to decide whether to
  // fire, and prior versions of this builder copied those strings into
  // the prompt without cascading the includes they referenced. The
  // word-boundary scanner is happy to run against encoded-query
  // syntax too — those just won't match any include names.
  function seedScriptsFor(d) {
    const out = [];
    const active = (env) => (env?.rows || []).filter(r => isTrue(r.active) || r.active == null);
    const push = (label, body) => {
      if (body) out.push({ label, body: String(body) });
    };
    for (const r of active(d.br)) {
      push(`BR/${r.name}`,            r.script);
      push(`BR/${r.name}/condition`,  r.condition);
      push(`BR/${r.name}/filter`,     r.filter_condition);
    }
    for (const r of active(d.cs)) {
      push(`CS/${r.name}`,           r.script);
      push(`CS/${r.name}/condition`, r.condition);
    }
    for (const p of active(d.uip)) {
      push(`UIP/${p.short_description}/true`,  p.script_true);
      push(`UIP/${p.short_description}/false`, p.script_false);
    }
    return out;
  }

  function CopyLlmPromptButton({ name, d }) {
    // The button opens an options popover; the user picks what to
    // include in the prompt and presses Build. The cascade was opt-in
    // by design — it makes a paged round-trip per matched include and
    // can multiply the prompt size by 5-10×. Most clicks don't need
    // it, so the base prompt is the default and "Resolve script
    // includes" is the first opt-in.
    //
    // The modal that opens with the result handles clipboard
    // shenanigans (http context + post-await gesture loss) by
    // pre-selecting a readonly textarea — see PromptModal below.
    const [building, setBuilding] = useState(false);
    const [modal, setModal]       = useState(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const [opts, setOpts]         = useState({ resolveIncludes: false });
    const anchorRef               = React.useRef(null);
    const readiness = ['br', 'cs', 'uip', 'uipa', 'dp', 'dpr'].map(k => {
      const e = d[k];
      return !!(e && Array.isArray(e.rows));
    });
    const ready = readiness.every(Boolean);
    const basePrompt = useMemo(() => ready ? buildLogicPrompt(name, d) : '', [ready, name, d]);
    const baseKb = basePrompt ? Math.round(basePrompt.length / 1024) : 0;

    useEffect(() => {
      if (!menuOpen) return;
      const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
      // Defer the click listener registration past the click that
      // opened the menu — otherwise the same click closes it.
      let onClickOutside;
      const t = setTimeout(() => {
        onClickOutside = (e) => {
          if (anchorRef.current && !anchorRef.current.contains(e.target)) setMenuOpen(false);
        };
        window.addEventListener('click', onClickOutside);
      }, 0);
      window.addEventListener('keydown', onKey);
      return () => {
        clearTimeout(t);
        if (onClickOutside) window.removeEventListener('click', onClickOutside);
        window.removeEventListener('keydown', onKey);
      };
    }, [menuOpen]);

    const build = async () => {
      if (!ready || !basePrompt || building) return;
      setMenuOpen(false);
      setBuilding(true);
      let cascadeError = null;
      try {
        let tail = '';
        if (opts.resolveIncludes) {
          try {
            const seeds = seedScriptsFor(d);
            const cascaded = await gatherCascadedIncludes(seeds);
            tail = renderIncludesSection(cascaded, basePrompt.length);
          } catch (e) {
            cascadeError = e;
            if (typeof console !== 'undefined') console.error('cascade failed:', e);
          }
        }
        setModal({ text: basePrompt + tail, cascadeError });
      } catch (e) {
        // Outer build failure (very rare — state update or string concat).
        // Surface as a modal banner so the user can copy the message rather
        // than seeing a tiny "build failed" sliver beside the button.
        if (typeof console !== 'undefined') console.error('prompt build failed:', e);
        setModal({ text: basePrompt || '(no base prompt)', cascadeError: cascadeError || e });
      } finally {
        setBuilding(false);
      }
    };

    return (
      <span ref={anchorRef} style={{ marginLeft: 'auto', position: 'relative', display: 'inline-block' }}>
        <button onClick={() => ready && !building && setMenuOpen(o => !o)}
          disabled={!ready || building}
          title={ready
            ? `Build an LLM prompt of every active rule on ${name}. Click for options.`
            : 'Waiting for all tabs to load…'}
          style={{
            padding: '4px 10px',
            fontSize: 11.5,
            height: 24,
            borderRadius: 12,
            background: menuOpen ? 'var(--accent-bg)' : 'var(--bg-elev)',
            border: '1px solid ' + (menuOpen ? 'var(--accent-border)' : 'var(--border-2)'),
            color: menuOpen ? 'var(--accent-fg)' : 'var(--fg-2)',
            cursor: ready && !building ? 'pointer' : 'not-allowed',
            opacity: ready ? 1 : 0.6,
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
          <window.Icon name={building ? 'refresh' : 'download'} size={11} />
          {building
            ? 'Resolving includes…'
            : ready
              ? <>
                  Build LLM prompt
                  <span className="mono" style={{ color: 'var(--fg-4)' }}>
                    {baseKb}{opts.resolveIncludes ? '+ KB' : ' KB'}
                  </span>
                  <window.Icon name="chevron_down" size={10} />
                </>
              : 'Loading…'}
        </button>
        {menuOpen && (
          <div style={{
            position: 'absolute', top: 'calc(100% + 4px)', right: 0,
            width: 320,
            background: 'var(--bg-elev)', border: '1px solid var(--border-2)', borderRadius: 8,
            boxShadow: 'var(--shadow-lg)', padding: 10,
            zIndex: 200,
            display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            <div style={{ fontSize: 11, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
              Prompt options
            </div>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', padding: '4px 0' }}>
              <input
                type="checkbox"
                checked={opts.resolveIncludes}
                onChange={e => setOpts(o => ({ ...o, resolveIncludes: e.target.checked }))}
                style={{ marginTop: 2 }}
              />
              <span style={{ fontSize: 12.5 }}>
                Resolve script includes
                <div style={{ fontSize: 11, color: 'var(--fg-4)', marginTop: 2, lineHeight: 1.4 }}>
                  Walk the script bodies and rule conditions for sys_script_include
                  references, fetch each include's source, repeat transitively.
                  Adds the include code to the prompt so the model can reason about
                  helper utilities. Can add hundreds of KB; takes a few seconds.
                </div>
              </span>
            </label>
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              <button onClick={() => setMenuOpen(false)} className="toggle"
                style={{ padding: '4px 10px', fontSize: 11.5, height: 24, borderRadius: 12 }}>
                Cancel
              </button>
              <button onClick={build} className="toggle on"
                style={{ padding: '4px 10px', fontSize: 11.5, height: 24, borderRadius: 12, marginLeft: 'auto' }}>
                Build prompt
              </button>
            </div>
          </div>
        )}
        {modal && <PromptModal text={modal.text} table={name} cascadeError={modal.cascadeError} onClose={() => setModal(null)} />}
      </span>
    );
  }

  // The textarea is auto-selected on mount so Ctrl/Cmd+C works the
  // instant the modal opens — that's the floor that works regardless
  // of clipboard-API availability. The Copy button on top tries the
  // async clipboard API first (works on https / localhost), then
  // execCommand inside its own fresh user-gesture (works on http for
  // most browsers as long as policy hasn't disabled it), then leaves
  // the textarea selected and lets the user copy manually.
  function PromptModal({ text, table, cascadeError, onClose }) {
    const taRef = React.useRef(null);
    const [copied, setCopied] = useState(false);
    const [howCopied, setHowCopied] = useState('');
    useEffect(() => {
      // Defer selection so the focus race against the modal mount
      // settles in the right order.
      const t = setTimeout(() => {
        if (taRef.current) { taRef.current.focus(); taRef.current.select(); }
      }, 30);
      return () => clearTimeout(t);
    }, []);
    useEffect(() => {
      const onKey = (e) => { if (e.key === 'Escape') onClose(); };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);
    const flash = (label) => {
      setCopied(true); setHowCopied(label);
      setTimeout(() => { setCopied(false); setHowCopied(''); }, 2400);
    };
    const doCopy = () => {
      if (taRef.current) { taRef.current.focus(); taRef.current.select(); }
      // Prefer the modern API when available
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
          .then(() => flash('clipboard API'))
          .catch(() => {
            try {
              if (document.execCommand('copy')) flash('execCommand');
            } catch (_) { /* selection still set — user can ctrl+c */ }
          });
        return;
      }
      try {
        if (document.execCommand('copy')) flash('execCommand');
      } catch (_) { /* selection still set — user can ctrl+c */ }
    };
    const kb = Math.round(text.length / 1024);
    return (
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <div onClick={e => e.stopPropagation()} style={{
          background: 'var(--bg)', border: '1px solid var(--border-2)', borderRadius: 12,
          boxShadow: 'var(--shadow-lg)', padding: 16,
          width: 'min(960px, 94vw)', height: 'min(720px, 88vh)',
          display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <window.Icon name="download" size={16} />
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
              LLM prompt — <span className="mono">{table}</span>
            </h3>
            <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{kb} KB</span>
            <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--fg-4)' }}>
              Textarea is pre-selected — <span className="mono">⌘C</span> / <span className="mono">Ctrl+C</span> works
            </span>
          </div>
          {cascadeError && (
            <div style={{
              background: 'var(--c-red-bg)', border: '1px solid var(--c-red-border)',
              color: 'var(--c-red)', borderRadius: 6, padding: '8px 12px',
              fontSize: 12, display: 'flex', alignItems: 'flex-start', gap: 8,
            }}>
              <window.Icon name="info" size={13} />
              <div style={{ flex: 1, lineHeight: 1.5 }}>
                <strong style={{ fontWeight: 600 }}>Script-include cascade failed.</strong>{' '}
                The prompt below is the base table logic only — referenced
                includes were not appended.
                <div style={{ marginTop: 4, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--c-red)', wordBreak: 'break-word' }}>
                  {cascadeError && cascadeError.message ? cascadeError.message : String(cascadeError)}
                </div>
                <div style={{ marginTop: 4, fontSize: 11, color: 'var(--fg-4)' }}>
                  Full stack in browser console (F12 → Console).
                </div>
              </div>
            </div>
          )}
          <textarea ref={taRef} readOnly value={text}
            spellCheck={false} autoCapitalize="off"
            style={{
              flex: 1, fontFamily: 'var(--font-mono)', fontSize: 11.5,
              padding: 12, background: 'var(--bg-2)', color: 'var(--fg-2)',
              border: '1px solid var(--border)', borderRadius: 6, resize: 'none',
              whiteSpace: 'pre', overflow: 'auto', tabSize: 2,
            }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 11, color: 'var(--fg-4)' }}>
              {copied ? `Copied via ${howCopied}.` : 'Paste into ChatGPT / Claude / Gemini.'}
            </span>
            <button onClick={onClose} className="toggle"
              style={{ marginLeft: 'auto', padding: '6px 14px' }}>
              Close
            </button>
            <button onClick={doCopy} className={'toggle' + (copied ? ' on' : '')}
              style={{ padding: '6px 14px' }}>
              <window.Icon name={copied ? 'check' : 'download'} size={11} />
              {copied ? 'Copied' : 'Copy to clipboard'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  function InspectorTabs({ tabs, active, onChange, totals }) {
    return (
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 2, borderBottom: '1px solid var(--border-2)',
        marginBottom: 6,
      }}>
        {tabs.map(t => {
          const env = totals[t.id] || { total: 0, missing: false, loading: true };
          return (
            <button key={t.id} onClick={() => onChange(t.id)}
              style={{
                padding: '6px 12px', fontSize: 12.5, fontWeight: 500,
                border: 'none', cursor: 'pointer', background: 'transparent',
                color: active === t.id ? 'var(--accent-fg)' : (env.missing ? 'var(--fg-4)' : 'var(--fg-2)'),
                borderBottom: active === t.id ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: -1,
              }}>
              {t.label}{' '}
              <span style={{ color: 'var(--fg-4)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                {env.loading ? '…' : env.missing ? '(?)' : `(${(env.total ?? env.rows?.length ?? 0).toLocaleString()})`}
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  function InspectorRows({ r, columns, table }) {
    if (r.loading) return <Loading />;
    if (r.missing) return <NotInSnapshot table={table} />;
    if (!r.rows.length) {
      return <Empty text={`No ${tableHumanName(table)} run on this table.`} />;
    }
    if (columns === 'br') {
      return (
        <table className="dt">
          <thead><tr>
            <th>Name</th>
            <th style={{ width: 110 }}>When</th>
            <th style={{ width: 80 }} className="num">Order</th>
            <th style={{ width: 80 }}>Active</th>
            <th style={{ width: 90 }}>Conditions</th>
          </tr></thead>
          <tbody>
            {r.rows.map(row => (
              <tr key={row.sys_id} onClick={() => window.navigate(`/business-rules/${row.sys_id}`)}>
                <td><NameWithDesc name={flat(row.name)} desc={flat(row.description) || flat(row.short_description)} /></td>
                <td><WhenChip when={flat(row.when) || dv(row, 'when')} /></td>
                <td className="num mono">{flat(row.order) ?? '—'}</td>
                <td>{isTrue(flat(row.active)) ? <span className="chip green">active</span> : <span className="chip">inactive</span>}</td>
                <td>{flat(row.condition) || flat(row.filter_condition) ? <span style={chip}>has filter</span> : <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    if (columns === 'cs') {
      return (
        <table className="dt">
          <thead><tr>
            <th>Name</th>
            <th style={{ width: 110 }}>Type</th>
            <th style={{ width: 100 }}>UI type</th>
            <th style={{ width: 130 }}>Field</th>
            <th style={{ width: 80 }}>Active</th>
          </tr></thead>
          <tbody>
            {r.rows.map(row => (
              <tr key={row.sys_id} onClick={() => window.navigate(`/client-scripts/${row.sys_id}`)}>
                <td><NameWithDesc name={flat(row.name)} desc={flat(row.description)} /></td>
                <td><ClientScriptTypeChip type={flat(row.type) || dv(row, 'type')} /></td>
                <td className="mono" style={{ fontSize: 11.5 }}>{flat(row.ui_type) || dv(row, 'ui_type') || '—'}</td>
                <td className="mono" style={{ fontSize: 11.5 }}>{flat(row.field_name) || dv(row, 'field_name') || '—'}</td>
                <td>{isTrue(flat(row.active)) ? <span className="chip green">active</span> : <span className="chip">inactive</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    if (columns === 'uip') {
      return (
        <table className="dt">
          <thead><tr>
            <th>Description</th>
            <th style={{ width: 90 }}>On load</th>
            <th style={{ width: 80 }} className="num">Order</th>
            <th style={{ width: 90 }}>Reverse</th>
            <th style={{ width: 80 }}>Active</th>
          </tr></thead>
          <tbody>
            {r.rows.map(row => (
              <tr key={row.sys_id}>
                <td><NameWithDesc name={flat(row.short_description)} desc={flat(row.description)} /></td>
                <td>{isTrue(flat(row.on_load)) ? <span className="chip green">yes</span> : <span className="muted">—</span>}</td>
                <td className="num mono">{flat(row.order) ?? '—'}</td>
                <td>{isTrue(flat(row.reverse_if_false)) ? <span style={chip}>yes</span> : <span className="muted">—</span>}</td>
                <td>{isTrue(flat(row.active)) ? <span className="chip green">active</span> : <span className="chip">inactive</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    if (columns === 'uipa') {
      return (
        <table className="dt">
          <thead><tr>
            <th>Field</th>
            <th style={{ width: 100 }}>Visible</th>
            <th style={{ width: 110 }}>Mandatory</th>
            <th style={{ width: 100 }}>Read-only</th>
            <th>Parent policy</th>
          </tr></thead>
          <tbody>
            {r.rows.map(row => {
              const v = String(flat(row.visible) || 'leave_alone');
              const m = String(flat(row.mandatory) || 'leave_alone');
              const ro = String(flat(row.disabled) || 'leave_alone');
              return (
                <tr key={row.sys_id}>
                  <td className="mono" style={{ fontSize: 11.5 }}>{flat(row.field) || dv(row, 'field') || '—'}</td>
                  <td>{tristate(v)}</td>
                  <td>{tristate(m)}</td>
                  <td>{tristate(ro)}</td>
                  <td className="mono" style={{ fontSize: 11.5, color: 'var(--fg-4)' }}>{dv(row, 'ui_policy') || flat(row.ui_policy) || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      );
    }
    if (columns === 'dp') {
      return (
        <table className="dt">
          <thead><tr>
            <th>Description</th>
            <th style={{ width: 100 }}>Enforce UI</th>
            <th style={{ width: 90 }}>Inherit</th>
            <th style={{ width: 80 }}>Active</th>
          </tr></thead>
          <tbody>
            {r.rows.map(row => (
              <tr key={row.sys_id}>
                <td><NameWithDesc name={flat(row.short_description)} desc={flat(row.description)} /></td>
                <td>{isTrue(flat(row.enforce_ui)) ? <span className="chip blue">yes</span> : <span className="muted">—</span>}</td>
                <td>{isTrue(flat(row.inherit)) ? <span style={chip}>yes</span> : <span className="muted">—</span>}</td>
                <td>{isTrue(flat(row.active)) ? <span className="chip green">active</span> : <span className="chip">inactive</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    if (columns === 'dpr') {
      return (
        <table className="dt">
          <thead><tr>
            <th>Field</th>
            <th style={{ width: 110 }}>Mandatory</th>
            <th style={{ width: 100 }}>Disabled</th>
            <th>Parent policy</th>
          </tr></thead>
          <tbody>
            {r.rows.map(row => {
              const m = String(flat(row.mandatory) || 'leave_alone');
              const dis = String(flat(row.disabled) || 'leave_alone');
              return (
                <tr key={row.sys_id}>
                  <td className="mono" style={{ fontSize: 11.5 }}>{flat(row.field) || dv(row, 'field') || '—'}</td>
                  <td>{tristate(m)}</td>
                  <td>{tristate(dis)}</td>
                  <td className="mono" style={{ fontSize: 11.5, color: 'var(--fg-4)' }}>{dv(row, 'sys_data_policy') || flat(row.sys_data_policy) || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      );
    }
    return <Empty text="Unknown view." />;
  }

  function tristate(v) {
    if (v === 'true')  return <span className="chip green">true</span>;
    if (v === 'false') return <span className="chip red">false</span>;
    return <span className="muted">—</span>;
  }
  function tableHumanName(t) {
    const m = {
      sys_script: 'business rules',
      sys_script_client: 'client scripts',
      sys_ui_policy: 'UI policies',
      sys_ui_policy_action: 'UI policy actions',
      sys_data_policy2: 'data policies',
      sys_data_policy_rule: 'data policy rules',
    };
    return m[t] || t;
  }
})();
