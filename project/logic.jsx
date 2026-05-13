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
  // needs it, then cached for the rest of the session. Each entry:
  // { sys_id, name, api_name, all_names: [strings to match] }. all_names
  // is the de-duped list we run word-boundary regex against, so a single
  // include with name "ScheduleEntry" + api_name "global.ScheduleEntry"
  // produces both forms once.
  let _includeIndex = null;
  function getIncludeIndex() {
    if (_includeIndex) return _includeIndex;
    _includeIndex = fetchAllRows('sys_script_include', {
      order_by: 'name', dir: 'asc',
    }).then(r => {
      if (r.missing) return [];
      return r.rows.map(row => {
        const sid = row.sys_id;
        const name = String(row.name || '').trim();
        const api  = String(row.api_name || '').trim();
        const names = new Set();
        if (name) names.add(name);
        if (api) {
          names.add(api);
          // global.MyUtils → MyUtils (matches when callers omit scope).
          const tail = api.split('.').pop();
          if (tail) names.add(tail);
        }
        return { sys_id: sid, name, api_name: api, all_names: [...names] };
      });
    }).catch(() => []);
    return _includeIndex;
  }

  // Scan an arbitrary script body for include references. Returns the
  // sys_include row objects (deduped) whose name or api_name appears as
  // a whole word in `text`. Word-boundary regex prevents false positives
  // like "Schedule" inside "ScheduleEntry".
  function scanForIncludes(text, includes) {
    if (!text || !includes || !includes.length) return [];
    const hits = new Map();
    for (const inc of includes) {
      for (const n of inc.all_names) {
        if (!n || n.length < 3) continue;  // skip very short names; too noisy
        const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp('\\b' + esc + '\\b');
        if (re.test(text)) {
          hits.set(inc.sys_id, inc);
          break;
        }
      }
    }
    return [...hits.values()];
  }

  const L = {
    fetchTable,
    fetchAllRows,
    getIncludeIndex,
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
        // Count of BR / CS that reference this include's name or api_name.
        // We do a `q=` search server-side (covers name / api_name / etc.
        // depending on the table) and then verify the match client-side
        // with a word-boundary regex so we don't get false hits.
        const names = [flat(r.name), flat(r.api_name)].filter(Boolean).map(String);
        const tail = (flat(r.api_name) || '').split('.').pop();
        if (tail && tail !== flat(r.api_name)) names.push(tail);
        if (!names.length) { setReferenced({ br: 0, cs: 0, sj: 0 }); return; }
        const probe = (table) => Promise.all(names.map(n =>
          L.fetchTable(table, { q: n, limit: 1 }).catch(() => ({ rows: [], total: 0, missing: true }))
        )).then(rs => {
          if (rs.some(x => x.missing)) return { missing: true, total: 0 };
          // Server `q` LIKE is a superset; we still report the totals here
          // as an upper bound. Exact occurrence-count requires scanning
          // the script bodies, which the BR/CS record pages do already.
          return { total: Math.max(...rs.map(x => x.total)), missing: false };
        });
        Promise.all([
          probe('sys_script'),
          probe('sys_script_client'),
          probe('sysauto_script'),
        ]).then(([br, cs, sj]) => {
          if (cancel) return;
          setReferenced({ br, cs, sj });
        });
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
            {referenced == null ? <Loading /> : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {[
                  ['Business rules',  referenced.br, '/business-rules'],
                  ['Client scripts',  referenced.cs, '/client-scripts'],
                  ['Scheduled jobs',  referenced.sj, '/scheduled-jobs'],
                ].map(([k, v, url]) => (
                  <div key={k} onClick={() => v && !v.missing && url && window.navigate(url)}
                       style={{
                         background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px',
                         cursor: v && !v.missing && v.total ? 'pointer' : 'default',
                       }}>
                    <div style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>{k}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14 }}>
                      {v?.missing ? '—' : (v?.total ?? 0).toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ marginTop: 10, fontSize: 11, color: 'var(--fg-4)', lineHeight: 1.55 }}>
              Counts are an upper bound from server-side <span className="mono">LIKE</span> search.
              Open an individual record to see the exact word-boundary match.
            </div>
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
