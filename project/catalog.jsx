/* eslint-disable */
// Service catalog — overview dashboard, catalog item list, and a per-item
// record view that mirrors ServiceNow's "related lists" tabs (Variables,
// Variable Sets, Catalog UI Policies, Catalog Client Scripts, Available For,
// Not Available For, Categories, Catalogs, Catalog Data Lookup Definitions,
// Related Articles, Related Catalog Items, Assigned Topics).
//
// Data layer: fetches real records from /api/sc_cat_item and the catalog
// admin tables (catalog_ui_policy, catalog_script_client, user_criteria,
// io_set_item, sc_cat_item_user_criteria_mtom, …). Each related list
// degrades gracefully — when a table isn't in the snapshot the tab shows
// an "(not in this snapshot)" empty state pointing at exporter coverage.

(function () {
  const data = window.HistoricalWowData;

  // ---- Tiny request-deduping cache --------------------------------------
  // The overview, list, and record views all touch /api/sc_cat_item. Cache
  // by URL so we only pay once per page-load; one in-flight promise per
  // URL means concurrent renders share the request.
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

  // /api/<table>?<params> with graceful fallback for tables that aren't
  // ingested yet. Returns { rows: [...], total: N, missing: bool }.
  // missing=true means the table isn't in REFERENCE_TABLES or the SQLite
  // DB — the tab can render an honest "not in snapshot" state.
  async function fetchTable(table, opts = {}) {
    try {
      const r = await data.fetchTaskList(table, opts);
      return { rows: r.rows || [], total: r.total || 0, missing: false };
    } catch (e) {
      const msg = (e && e.message) || '';
      if (/HTTP 404|HTTP 500|unknown table|no such table/i.test(msg)) {
        return { rows: [], total: 0, missing: true, error: msg };
      }
      // Unknown failure — surface as missing with the message so the UI
      // can show a useful hint rather than an empty list.
      return { rows: [], total: 0, missing: true, error: msg };
    }
  }

  // ---- Public catalog API ----------------------------------------------
  const C = {
    // Pull every sc_cat_item (213 in the live snapshot). Sorted by name.
    fetchAllItems: () => fetchCached('all_items', async () => {
      const r = await fetchTable('sc_cat_item', { limit: 5000, order_by: 'name', dir: 'asc' });
      return r.rows;
    }),
    fetchItem: (sys_id) => data.fetchRecord('sc_cat_item', sys_id),
    fetchVariablesFor: (sys_id) => fetchTable('item_option_new', {
      limit: 500, filters: { cat_item: sys_id }, order_by: 'order', dir: 'asc',
    }),
    fetchUIPoliciesFor: (sys_id) => fetchTable('catalog_ui_policy', {
      limit: 200, filters: { cat_item: sys_id }, order_by: 'order', dir: 'asc',
    }),
    fetchUIPolicyActionsFor: (sys_id) => fetchTable('catalog_ui_policy_action', {
      limit: 500, filters: { cat_item: sys_id },
    }),
    fetchClientScriptsFor: (sys_id) => fetchTable('catalog_script_client', {
      limit: 200, filters: { cat_item: sys_id }, order_by: 'name', dir: 'asc',
    }),
    fetchAvailableFor: (sys_id) => fetchTable('sc_cat_item_user_criteria_mtom', {
      limit: 200, filters: { sc_cat_item: sys_id },
    }),
    fetchNotAvailableFor: (sys_id) => fetchTable('sc_cat_item_user_criteria_no_mtom', {
      limit: 200, filters: { sc_cat_item: sys_id },
    }),
    fetchVariableSetsFor: (sys_id) => fetchTable('io_set_item', {
      limit: 100, filters: { sc_cat_item: sys_id }, order_by: 'order', dir: 'asc',
    }),
    fetchUserCriterion: (sys_id) => fetchCached('uc_' + sys_id,
      () => data.fetchRecord('user_criteria', sys_id).catch(() => null)),
    fetchVariableSet: (sys_id) => fetchCached('vset_' + sys_id,
      () => data.fetchRecord('item_option_new_set', sys_id).catch(() => null)),
    fetchCatalog: (sys_id) => fetchCached('catalog_' + sys_id,
      () => data.fetchRecord('sc_catalog', sys_id).catch(() => null)),
    fetchCategory: (sys_id) => fetchCached('category_' + sys_id,
      () => data.fetchRecord('sc_category', sys_id).catch(() => null)),
    // Aggregate counts the dashboard tiles want. Each of these is just a
    // count(*) query — limit=1, total field carries the count.
    fetchTotalCount: (table) => fetchCached('count_' + table, async () => {
      const r = await fetchTable(table, { limit: 1 });
      return { total: r.total, missing: r.missing };
    }, 30_000),
  };

  C._cache = _cache;
  window.HistoricalWowCatalog = C;
})();

// ===========================================================================
// UI
// ===========================================================================

(function () {
  const C = window.HistoricalWowCatalog;
  const data = window.HistoricalWowData;
  const { useState, useEffect, useMemo } = React;

  // Shared chip / surface styles used across the section.
  const chip = {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '2px 8px', borderRadius: 10, fontSize: 11,
    background: 'var(--bg-3)', border: '1px solid var(--border)', color: 'var(--fg-2)',
  };
  const accentChip = {
    ...chip, background: 'var(--accent-bg)',
    border: '1px solid var(--accent-border)', color: 'var(--accent-fg)',
  };

  // ---- Display-value helpers -------------------------------------------
  // Indexed columns are flat; reference columns come back as either a flat
  // sys_id (slim mode) or a {value, display_value} envelope. fetchTaskList
  // already calls flatten(), so values are scalars and the envelope's
  // display_value lands on __display_<key>. These helpers give the rest of
  // the file a single shape to read from.
  const flat = (v) => (v && typeof v === 'object' && 'value' in v) ? v.value : v;
  const dv = (r, k) => r['__display_' + k] || flat(r[k]);
  const isTrue = (v) => v === true || v === 'true' || v === 1 || v === '1';

  // ---- Loading + Empty + ErrorState helpers ----------------------------
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
  // Used for tabs whose backing table isn't in the snapshot yet. Encourages
  // the right next step (extend the exporter) instead of pretending the
  // data just doesn't exist.
  function NotInSnapshot({ table }) {
    return (
      <Empty
        icon="archive"
        text={<>The <span className="mono" style={{ fontSize: 11.5 }}>{table}</span> table isn't in this snapshot.</>}
        hint={<>Add it to <span className="mono" style={{ fontSize: 11 }}>project/export/historicalwow_export.py</span> DEFAULT_TABLES, run the exporter, and rebuild the SQLite DB.</>}
      />
    );
  }

  // =========================================================================
  // Overview dashboard
  // =========================================================================
  window.CatalogOverviewPage = function CatalogOverviewPage() {
    const [items, setItems]   = useState(null);
    const [counts, setCounts] = useState(null);  // { table: { total, missing } }
    const [ritms, setRitms]   = useState(null);  // recent RITMs for usage overlay
    const [ritmTotal, setRitmTotal] = useState(0);

    useEffect(() => {
      window.AuditLog.push('view', 'service-catalog', 'Service catalog overview');
      let cancel = false;
      C.fetchAllItems()
        .then(rs => { if (!cancel) setItems(rs); })
        .catch(() => { if (!cancel) setItems([]); });
      // Aggregate counts for the related-list tables so KPI tiles know
      // what's actually available in the snapshot.
      Promise.all([
        'sc_cat_item', 'item_option_new', 'sc_catalog', 'sc_category',
        'catalog_ui_policy', 'catalog_script_client',
        'user_criteria', 'sc_cat_item_user_criteria_mtom', 'sc_cat_item_user_criteria_no_mtom',
        'item_option_new_set', 'io_set_item',
      ].map(t => C.fetchTotalCount(t).then(r => [t, r]))).then(pairs => {
        if (!cancel) {
          const m = {};
          for (const [t, r] of pairs) m[t] = r;
          setCounts(m);
        }
      });
      // Recent RITMs for the usage overlay
      data.fetchTaskList('sc_req_item', { limit: 2000, order_by: 'sys_updated_on', dir: 'desc' })
        .then(r => { if (!cancel) { setRitms(r.rows || []); setRitmTotal(r.total || 0); } })
        .catch(() => { if (!cancel) { setRitms([]); setRitmTotal(0); } });
      return () => { cancel = true; };
    }, []);

    // Aggregate per-cat_item RITM counts and outcomes from the real RITMs.
    const usageByCatItem = useMemo(() => {
      if (!ritms) return null;
      const m = new Map();
      for (const r of ritms) {
        const k = flat(r.cat_item) || ('__d:' + dv(r, 'cat_item'));
        if (!m.has(k)) m.set(k, { sys_id: flat(r.cat_item), name: dv(r, 'cat_item') || '(unnamed)', rows: [] });
        m.get(k).rows.push(r);
      }
      return m;
    }, [ritms]);

    const itemsByCatalog = useMemo(() => {
      if (!items) return new Map();
      const m = new Map();
      for (const it of items) {
        const k = dv(it, 'sc_catalogs') || '(uncategorized)';
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(it);
      }
      return m;
    }, [items]);

    const itemsByCategory = useMemo(() => {
      if (!items) return new Map();
      const m = new Map();
      for (const it of items) {
        const k = dv(it, 'category') || '(uncategorized)';
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(it);
      }
      return m;
    }, [items]);

    // Top items by RITM count
    const topItems = useMemo(() => {
      if (!items || !usageByCatItem) return null;
      const itemBySid = new Map(items.map(i => [i.sys_id, i]));
      const ranked = [];
      for (const u of usageByCatItem.values()) {
        const it = itemBySid.get(u.sys_id);
        if (!it) continue;  // catalog item from outside the snapshot
        ranked.push({
          item: it,
          ritmCount: u.rows.length,
          rows: u.rows,
        });
      }
      ranked.sort((a, b) => b.ritmCount - a.ritmCount);
      return ranked.slice(0, 12);
    }, [items, usageByCatItem]);

    // Outcome mix from the snapshot RITMs.
    const outcomeMix = useMemo(() => {
      const m = { 'Closed complete': 0, 'Closed incomplete': 0, 'Closed cancelled': 0,
                  'Closed rejected': 0, 'Open / in-progress': 0, '(other)': 0 };
      const decode = (s) => {
        s = String(s || '');
        if (s === '3') return 'Closed complete';
        if (s === '4') return 'Closed incomplete';
        if (s === '7') return 'Closed cancelled';
        if (s === '8') return 'Closed rejected';
        if (s === '1' || s === '2') return 'Open / in-progress';
        return '(other)';
      };
      if (ritms) for (const r of ritms) m[decode(flat(r.state))] += 1;
      return m;
    }, [ritms]);
    const outcomeTotal = Object.values(outcomeMix).reduce((a, b) => a + b, 0);
    const outcomeColor = {
      'Closed complete': 'var(--accent)',     'Closed incomplete': 'var(--c-amber)',
      'Closed cancelled': 'var(--c-gray)',    'Closed rejected': 'var(--c-red)',
      'Open / in-progress': 'var(--c-blue)',  '(other)': 'var(--fg-4)',
    };

    if (items === null || counts === null) {
      return (
        <div style={{ padding: '32px 32px 60px', maxWidth: 1200, margin: '0 auto' }}>
          <h1 style={{ fontSize: 26, fontWeight: 600 }}>Catalog overview</h1>
          <Loading label="Loading catalog…" />
        </div>
      );
    }

    const tile = (label, value, sub, table) => {
      const missing = table && counts[table] && counts[table].missing;
      return (
        <div style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' }}>
          <div style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{label}</div>
          <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-.02em', marginTop: 4, fontFamily: 'var(--font-mono)' }}>
            {missing ? '—' : (typeof value === 'number' ? value.toLocaleString() : value)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--fg-4)', marginTop: 2 }}>{missing ? `${table} not in snapshot` : sub}</div>
        </div>
      );
    };

    return (
      <div style={{ padding: '32px 32px 60px', maxWidth: 1200, margin: '0 auto' }}>
        <div style={{ marginBottom: 26 }}>
          <div style={{ fontSize: 11.5, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '.08em', fontWeight: 600 }}>
            Service Catalog
          </div>
          <h1 style={{ margin: '6px 0 8px', fontSize: 26, fontWeight: 600, letterSpacing: '-0.02em' }}>
            Catalog overview
          </h1>
          <div style={{ color: 'var(--fg-3)', fontSize: 13.5, maxWidth: 760, lineHeight: 1.6 }}>
            Every catalog item in this snapshot, with its real variables, UI policies,
            client scripts, and access criteria. Usage metrics are computed live from
            <span className="mono" style={{ fontSize: 12.5 }}> sc_req_item</span>.
          </div>
        </div>

        {/* KPI tiles */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 26 }}>
          {tile('Catalog items',     items.length, `${items.filter(i => isTrue(dv(i, 'active'))).length} active`, 'sc_cat_item')}
          {tile('Variables',         counts.item_option_new.total, `across ${items.length} items`, 'item_option_new')}
          {tile('UI policies',       counts.catalog_ui_policy.total, `${counts.catalog_script_client.total.toLocaleString()} client scripts`, 'catalog_ui_policy')}
          {tile('Requests',          ritmTotal || '…', ritms ? `${ritms.length.toLocaleString()} loaded for analysis` : 'loading sc_req_item…')}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 22 }}>
          {/* Most-used items */}
          <div>
            <h2 style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--fg-3)', margin: '0 0 10px' }}>
              Most-used items
            </h2>
            <div style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
              {topItems == null ? <Loading /> : topItems.length === 0 ? (
                <div style={{ padding: 24, color: 'var(--fg-4)', fontSize: 12.5, textAlign: 'center' }}>
                  No requested items in the snapshot reference catalog items we know about.
                </div>
              ) : (
                <table className="dt" style={{ width: '100%' }}>
                  <thead><tr>
                    <th>Catalog item</th>
                    <th style={{ width: 110 }}>Catalog</th>
                    <th style={{ width: 100 }} className="num">RITMs</th>
                    <th style={{ width: 130 }}>Outcome mix</th>
                  </tr></thead>
                  <tbody>
                    {topItems.map(t => {
                      // Compute outcome mix for this item
                      const mix = { f: 0, x: 0, c: 0, j: 0, o: 0 };
                      for (const r of t.rows) {
                        const s = String(flat(r.state) || '');
                        if (s === '3') mix.f++; else if (s === '4') mix.x++;
                        else if (s === '7') mix.c++; else if (s === '8') mix.j++;
                        else mix.o++;
                      }
                      const total = t.ritmCount || 1;
                      const w = (n) => Math.max(2, Math.round((n / total) * 100));
                      return (
                        <tr key={t.item.sys_id} onClick={() => window.navigate(`/catalog-items/${t.item.sys_id}`)}>
                          <td>
                            <strong style={{ fontWeight: 500 }}>{t.item.name}</strong>
                            <div style={{ fontSize: 11, color: 'var(--fg-4)' }}>
                              {dv(t.item, 'category') || '(uncategorized)'}
                            </div>
                          </td>
                          <td style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{dv(t.item, 'sc_catalogs') || '—'}</td>
                          <td className="num mono">{t.ritmCount.toLocaleString()}</td>
                          <td>
                            <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', border: '1px solid var(--border)' }}>
                              <div style={{ width: w(mix.f) + '%', background: 'var(--accent)' }} title={`complete ${mix.f}`} />
                              <div style={{ width: w(mix.o) + '%', background: 'var(--c-blue)' }} title={`in-progress ${mix.o}`} />
                              <div style={{ width: w(mix.x) + '%', background: 'var(--c-amber)' }} title={`incomplete ${mix.x}`} />
                              <div style={{ width: w(mix.c) + '%', background: 'var(--c-gray)' }} title={`cancelled ${mix.c}`} />
                              <div style={{ width: w(mix.j) + '%', background: 'var(--c-red)' }} title={`rejected ${mix.j}`} />
                            </div>
                            <div style={{ fontSize: 10, color: 'var(--fg-4)', marginTop: 2 }}>
                              {mix.f}/{total} complete
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* Outcome donut + breakdowns */}
          <div>
            <h2 style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--fg-3)', margin: '0 0 10px' }}>
              Request outcomes
            </h2>
            <div style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 14px 8px' }}>
              <Donut segments={Object.entries(outcomeMix).map(([k, v]) => ({ label: k, value: v, color: outcomeColor[k] }))}
                     total={outcomeTotal} subtitle="recent RITMs" />
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {Object.entries(outcomeMix).map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                    <span style={{ width: 9, height: 9, borderRadius: 2, background: outcomeColor[k] }} />
                    <span style={{ flex: 1, color: 'var(--fg-2)' }}>{k}</span>
                    <span className="mono" style={{ color: 'var(--fg-3)' }}>{v.toLocaleString()}</span>
                    <span className="mono" style={{ color: 'var(--fg-4)', width: 38, textAlign: 'right' }}>
                      {outcomeTotal ? Math.round((v / outcomeTotal) * 100) + '%' : '—'}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <h2 style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--fg-3)', margin: '20px 0 10px' }}>
              By catalog
            </h2>
            <div style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' }}>
              {[...itemsByCatalog.entries()].sort((a, b) => b[1].length - a[1].length).map(([cat, its]) => (
                <div key={cat} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 12.5 }}>{cat}</span>
                  <span className="mono" style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--fg-3)' }}>{its.length}</span>
                </div>
              ))}
            </div>

            <h2 style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--fg-3)', margin: '20px 0 10px' }}>
              By category
            </h2>
            <div style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px', maxHeight: 260, overflowY: 'auto' }}>
              {[...itemsByCategory.entries()].sort((a, b) => b[1].length - a[1].length).map(([cty, its]) => (
                <div key={cty} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 12.5 }}>{cty}</span>
                  <span className="mono" style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--fg-3)' }}>{its.length}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 28 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
            <h2 style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--fg-3)', margin: 0 }}>
              All catalog items <span className="mono" style={{ color: 'var(--fg-4)' }}>{items.length}</span>
            </h2>
            <a onClick={() => window.navigate('/catalog-items')} style={{ fontSize: 12, color: 'var(--accent-fg)', cursor: 'pointer' }}>
              Open list →
            </a>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
            {items.map(it => {
              const u = usageByCatItem?.get(it.sys_id);
              return (
                <div key={it.sys_id}
                     onClick={() => window.navigate(`/catalog-items/${it.sys_id}`)}
                     style={{
                       background: 'var(--bg-elev)', border: '1px solid var(--border)',
                       borderRadius: 8, padding: '10px 12px', cursor: 'pointer',
                       opacity: isTrue(dv(it, 'active')) ? 1 : 0.55,
                     }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <window.Icon name="file" size={12} />
                    <span style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.name}</span>
                    {!isTrue(dv(it, 'active')) && <span style={{ ...chip, fontSize: 10 }}>inactive</span>}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--fg-3)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {it.short_description || '—'}
                  </div>
                  <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--fg-4)' }}>
                    <span style={chip}>{dv(it, 'category') || 'no category'}</span>
                    <span className="mono" style={{ marginLeft: 'auto' }}>{u ? u.rows.length.toLocaleString() : 0} RITMs</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  function Donut({ segments, total, subtitle }) {
    const size = 160, stroke = 28, r = (size - stroke) / 2, c = size / 2;
    const circ = 2 * Math.PI * r;
    let acc = 0;
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={c} cy={c} r={r} fill="none" stroke="var(--bg-3)" strokeWidth={stroke} />
          {segments.map((s, i) => {
            if (!total || s.value === 0) return null;
            const frac = s.value / total;
            const dash = `${(circ * frac).toFixed(2)} ${(circ - circ * frac).toFixed(2)}`;
            const offset = -acc * circ;
            acc += frac;
            return (
              <circle key={i} cx={c} cy={c} r={r} fill="none"
                stroke={s.color} strokeWidth={stroke}
                strokeDasharray={dash} strokeDashoffset={offset}
                transform={`rotate(-90 ${c} ${c})`} />
            );
          })}
          <text x={c} y={c - 4} textAnchor="middle" style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fill: 'var(--fg)' }}>
            {(total || 0).toLocaleString()}
          </text>
          <text x={c} y={c + 14} textAnchor="middle" style={{ fontSize: 10, fill: 'var(--fg-4)' }}>
            {subtitle || ''}
          </text>
        </svg>
      </div>
    );
  }

  // =========================================================================
  // Catalog item list
  // =========================================================================
  window.CatalogItemListPage = function CatalogItemListPage() {
    const [items, setItems] = useState(null);
    const [q, setQ] = useState('');
    const [catalog, setCatalog] = useState('');
    const [category, setCategory] = useState('');
    const [activeOnly, setActiveOnly] = useState(false);

    useEffect(() => {
      window.AuditLog.push('list', 'sc_cat_item', '');
      let cancel = false;
      C.fetchAllItems().then(rs => { if (!cancel) setItems(rs); }).catch(() => { if (!cancel) setItems([]); });
      return () => { cancel = true; };
    }, []);

    const catalogs = useMemo(() => {
      if (!items) return [];
      return [...new Set(items.map(i => dv(i, 'sc_catalogs')).filter(Boolean))].sort();
    }, [items]);
    const categories = useMemo(() => {
      if (!items) return [];
      return [...new Set(items.map(i => dv(i, 'category')).filter(Boolean))].sort();
    }, [items]);

    const filtered = useMemo(() => {
      if (!items) return [];
      const ql = q.trim().toLowerCase();
      return items.filter(i => {
        if (catalog && dv(i, 'sc_catalogs') !== catalog) return false;
        if (category && dv(i, 'category') !== category) return false;
        if (activeOnly && !isTrue(dv(i, 'active'))) return false;
        if (!ql) return true;
        return [i.name, i.short_description, dv(i, 'category'), dv(i, 'sc_catalogs'), flat(i.sys_class_name)]
          .some(s => (s || '').toLowerCase().includes(ql));
      });
    }, [items, q, catalog, category, activeOnly]);

    return (
      <div>
        <div className="page-header">
          <h1>Catalog items <span className="count mono">{items ? items.length.toLocaleString() : '…'}</span></h1>
          <div className="sub">
            <span className="mono" style={{ color: 'var(--fg-4)' }}>sc_cat_item</span>
            {items && <> · {filtered.length.toLocaleString()} matching</>}
          </div>
          <div className="toolbar">
            <select value={catalog} onChange={e => setCatalog(e.target.value)}
              style={{ height: 26, padding: '0 10px', border: '1px solid var(--border-2)', borderRadius: 14, background: 'var(--bg-elev)', fontSize: 12, color: 'var(--fg)', outline: 'none' }}>
              <option value="">All catalogs</option>
              {catalogs.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={category} onChange={e => setCategory(e.target.value)}
              style={{ height: 26, padding: '0 10px', border: '1px solid var(--border-2)', borderRadius: 14, background: 'var(--bg-elev)', fontSize: 12, color: 'var(--fg)', outline: 'none' }}>
              <option value="">All categories</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <button className={'toggle' + (activeOnly ? ' on' : '')} onClick={() => setActiveOnly(v => !v)}
              style={{ padding: '0 12px', height: 26, fontSize: 12, borderRadius: 14 }}>
              active only
            </button>
            <div className="spacer" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name or description…"
              style={{ height: 26, padding: '0 10px', border: '1px solid var(--border-2)', borderRadius: 14, background: 'var(--bg-elev)', fontSize: 12, outline: 'none', width: 280, color: 'var(--fg)' }} />
          </div>
        </div>
        <table className="dt">
          <thead><tr>
            <th>Name</th>
            <th style={{ width: 200 }}>Category</th>
            <th style={{ width: 200 }}>Catalog</th>
            <th style={{ width: 120 }}>Type</th>
            <th style={{ width: 100 }} className="num">Status</th>
          </tr></thead>
          <tbody>
            {items === null && (
              <tr><td colSpan={5}><Loading label="Loading 213 catalog items…" /></td></tr>
            )}
            {items && filtered.length === 0 && (
              <tr><td colSpan={5} style={{ padding: '40px 20px', color: 'var(--fg-4)', textAlign: 'center' }}>No matching items.</td></tr>
            )}
            {filtered.map(it => (
              <tr key={it.sys_id} onClick={() => window.navigate(`/catalog-items/${it.sys_id}`)}>
                <td>
                  <strong style={{ fontWeight: 500 }}>{it.name}</strong>
                  <div style={{ fontSize: 11, color: 'var(--fg-4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 600 }}>
                    {it.short_description || '—'}
                  </div>
                </td>
                <td>{dv(it, 'category') || <span style={{ color: 'var(--fg-4)' }}>—</span>}</td>
                <td>{dv(it, 'sc_catalogs') || <span style={{ color: 'var(--fg-4)' }}>—</span>}</td>
                <td className="mono" style={{ fontSize: 11.5 }}>{flat(it.sys_class_name) || 'sc_cat_item'}</td>
                <td>
                  {isTrue(dv(it, 'active'))
                    ? <span className="chip green">active</span>
                    : <span className="chip">inactive</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  // =========================================================================
  // Catalog item record — the screen with the 12 related-list tabs
  // =========================================================================
  window.CatalogItemRecordPage = function CatalogItemRecordPage({ sys_id, showRaw }) {
    const [rec, setRec] = useState(null);  // null=loading, false=not-found
    const [tab, setTab] = useState('variables');
    const [related, setRelated] = useState({});  // tab id → { rows, total, missing }
    const [usage, setUsage] = useState(null);

    useEffect(() => {
      let cancel = false;
      setRec(null); setRelated({}); setUsage(null);
      C.fetchItem(sys_id).then(r => {
        if (cancel) return;
        if (!r) { setRec(false); return; }
        setRec(r);
        window.AuditLog.push('view', `sc_cat_item/${flat(r.name) || sys_id.slice(0, 8)}`, flat(r.name) || '');
      }).catch(e => {
        if (cancel) return;
        if (e && /403/.test(e.message || '')) setRec({ __hr_locked: true, sys_id });
        else setRec(false);
      });
      // Fan out related-list queries in parallel — every tab gets its data
      // available immediately on switch, no per-tab spinner round-trip.
      const fetchAll = [
        ['variables', C.fetchVariablesFor(sys_id)],
        ['vsets',     C.fetchVariableSetsFor(sys_id)],
        ['policies',  C.fetchUIPoliciesFor(sys_id)],
        ['actions',   C.fetchUIPolicyActionsFor(sys_id)],
        ['scripts',   C.fetchClientScriptsFor(sys_id)],
        ['available', C.fetchAvailableFor(sys_id)],
        ['notavail',  C.fetchNotAvailableFor(sys_id)],
      ];
      for (const [k, p] of fetchAll) {
        p.then(r => { if (!cancel) setRelated(prev => ({ ...prev, [k]: r })); })
          .catch(() => { if (!cancel) setRelated(prev => ({ ...prev, [k]: { rows: [], total: 0, missing: true } })); });
      }
      // Recent RITMs that reference this catalog item
      data.fetchTaskList('sc_req_item', { limit: 25, filters: { cat_item: sys_id }, order_by: 'sys_updated_on', dir: 'desc' })
        .then(r => { if (!cancel) setUsage(r); })
        .catch(() => { if (!cancel) setUsage({ rows: [], total: 0 }); });
      return () => { cancel = true; };
    }, [sys_id]);

    if (rec === null) {
      return <div className="empty"><div className="dot-pulse" style={{ marginBottom: 12 }} />loading catalog item…</div>;
    }
    if (rec === false) {
      return <div className="empty"><div className="glyph"><window.Icon name="info" /></div>Catalog item not in snapshot.</div>;
    }
    if (rec.__hr_locked) {
      return <div className="empty"><div className="glyph"><window.Icon name="lock" /></div>Restricted.</div>;
    }

    const name = flat(rec.name) || '(unnamed)';
    const desc = flat(rec.description) || flat(rec.short_description) || '';
    const cat = dv(rec, 'category') || dv(rec, 'topic') || '—';
    const cata = dv(rec, 'sc_catalogs') || '—';
    const active = isTrue(dv(rec, 'active'));
    const type = dv(rec, 'type') || flat(rec.sys_class_name) || 'Item';

    // Each tab row uses the related[<key>] envelope; missing=true marks
    // tabs whose backing table isn't pulled by the exporter yet.
    const r = (key) => related[key] || { rows: [], total: 0, missing: false, loading: true };
    const tabs = [
      { id: 'variables',  label: 'Variables',                 r: r('variables') },
      { id: 'vsets',      label: 'Variable Sets',             r: r('vsets') },
      { id: 'policies',   label: 'Catalog UI Policies',       r: r('policies') },
      { id: 'scripts',    label: 'Catalog Client Scripts',    r: r('scripts') },
      { id: 'available',  label: 'Available For',             r: r('available') },
      { id: 'notavail',   label: 'Not Available For',         r: r('notavail') },
      { id: 'categories', label: 'Categories',                r: { rows: cat !== '—' ? [{ name: cat }] : [], total: cat !== '—' ? 1 : 0 } },
      { id: 'catalogs',   label: 'Catalogs',                  r: { rows: cata !== '—' ? [{ name: cata }] : [], total: cata !== '—' ? 1 : 0 } },
      { id: 'lookups',    label: 'Catalog Data Lookup Definitions', r: { rows: [], total: 0, missing: true, table: 'sc_cat_item_data_lookup_definitions' } },
      { id: 'articles',   label: 'Related Articles',          r: { rows: [], total: 0, missing: true, table: 'm2m_kb_to_sc_cat_item' } },
      { id: 'relitems',   label: 'Related Catalog Items',     r: { rows: [], total: 0, missing: true, table: 'sc_cat_item_related_items' } },
      { id: 'topics',     label: 'Assigned Topics',           r: { rows: [], total: 0, missing: true, table: 'topic_item' } },
    ];

    return (
      <div className="record">
        <div className="left">
          <div className="record-header">
            <div className="crumbs">
              <a onClick={() => window.navigate('/service-catalog')}>Service catalog</a>
              <window.Icon name="chevron_right" size={11} />
              <a onClick={() => window.navigate('/catalog-items')}>Catalog items</a>
              <window.Icon name="chevron_right" size={11} />
              <span className="mono">{name}</span>
            </div>
            <h1>
              <window.Icon name="file" size={22} />
              <span style={{ flex: 1, minWidth: 0 }}>{name}</span>
            </h1>
            <div className="title-row">
              {active ? <span className="chip green">active</span> : <span className="chip">inactive</span>}
              <span style={chip}>{cat}</span>
              <span style={chip}>{cata}</span>
              <span style={chip}>{type}</span>
              {dv(rec, 'delivery_time') && <><span className="dot">·</span><span>delivery {dv(rec, 'delivery_time')}</span></>}
              {flat(rec.price) && <><span className="dot">·</span><span>{flat(rec.price)}{flat(rec.recurring_price) ? ' / ' + flat(rec.recurring_price) : ''}</span></>}
              <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--fg-4)' }}>
                sys_id {sys_id.slice(0, 8)}…
              </span>
            </div>
          </div>

          {desc && (
            <div className="section">
              <h3>Description</h3>
              <div className="kv-block" style={{ whiteSpace: 'pre-wrap' }}
                dangerouslySetInnerHTML={{ __html: stripUnsafe(desc) }} />
            </div>
          )}

          <div className="section">
            <h3>Item details</h3>
            <div className="fields" style={{ display: 'grid', gridTemplateColumns: '180px 1fr', rowGap: 8, columnGap: 16 }}>
              <Field label="Name">{name}</Field>
              <Field label="Catalog">{cata}</Field>
              <Field label="Category">{cat}</Field>
              <Field label="Type">{type}</Field>
              <Field label="Active">{active ? 'true' : 'false'}</Field>
              <Field label="Delivery time">{dv(rec, 'delivery_time') || '—'}</Field>
              <Field label="Price">{flat(rec.price) || '—'}</Field>
              <Field label="Recurring price">{flat(rec.recurring_price) || '—'}</Field>
              <Field label="Workflow">{dv(rec, 'workflow') || '—'}</Field>
              <Field label="Availability">{dv(rec, 'availability') || '—'}</Field>
              <Field label="Created">{flat(rec.sys_created_on) || '—'} <span style={{ color: 'var(--fg-4)' }}>by {flat(rec.sys_created_by) || '—'}</span></Field>
              <Field label="Updated">{flat(rec.sys_updated_on) || '—'} <span style={{ color: 'var(--fg-4)' }}>by {flat(rec.sys_updated_by) || '—'}</span></Field>
            </div>
          </div>

          <div className="section">
            <CatalogTabs tabs={tabs} active={tab} onChange={setTab} />
            <div style={{ paddingTop: 8 }}>
              {tab === 'variables'  && <VariablesTab r={r('variables')} />}
              {tab === 'vsets'      && <VariableSetsTab r={r('vsets')} />}
              {tab === 'policies'   && <UIPoliciesTab r={r('policies')} actions={r('actions')} />}
              {tab === 'scripts'    && <ClientScriptsTab r={r('scripts')} />}
              {tab === 'available'  && <UserCriteriaTab r={r('available')} kind="allow" />}
              {tab === 'notavail'   && <UserCriteriaTab r={r('notavail')} kind="deny" />}
              {tab === 'categories' && <CategoriesTab name={cat} sys_id={flat(rec.category)} />}
              {tab === 'catalogs'   && <CatalogsTab name={cata} sys_id={flat(rec.sc_catalogs)} />}
              {tab === 'lookups'    && <NotInSnapshot table="sc_cat_item_data_lookup_definitions" />}
              {tab === 'articles'   && <NotInSnapshot table="m2m_kb_to_sc_cat_item" />}
              {tab === 'relitems'   && <NotInSnapshot table="sc_cat_item_related_items" />}
              {tab === 'topics'     && <NotInSnapshot table="topic_item" />}
            </div>
          </div>

          <ManifestFooterCat />
        </div>

        {/* Right pane — usage panel */}
        <div className="right">
          <div className="section" style={{ padding: '12px 14px' }}>
            <h3 style={{ marginBottom: 8 }}>Usage</h3>
            {usage == null ? <Loading /> : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {[
                  ['RITMs (matching)', usage.total.toLocaleString()],
                  ['Loaded', usage.rows.length.toLocaleString()],
                  ['Variables', r('variables').total.toLocaleString()],
                  ['UI policies', r('policies').missing ? '—' : r('policies').total.toLocaleString()],
                  ['Client scripts', r('scripts').missing ? '—' : r('scripts').total.toLocaleString()],
                  ['Variable sets', r('vsets').missing ? '—' : r('vsets').total.toLocaleString()],
                  ['Available For', r('available').missing ? '—' : r('available').total.toLocaleString()],
                  ['Not Available', r('notavail').missing ? '—' : r('notavail').total.toLocaleString()],
                ].map(([k, v]) => (
                  <div key={k} style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px' }}>
                    <div style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>{k}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14 }}>{v}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="section" style={{ padding: '12px 14px' }}>
            <h3 style={{ marginBottom: 8 }}>Recent RITMs</h3>
            {usage == null && <Loading />}
            {usage && usage.rows.length === 0 && (
              <div style={{ color: 'var(--fg-4)', fontSize: 12 }}>
                No requested items reference this catalog item.
              </div>
            )}
            {(usage?.rows || []).map(r => (
              <div key={r.sys_id}
                   onClick={() => window.navigate(window.recordUrl('sc_req_item', r.sys_id))}
                   style={{
                     background: 'var(--bg-elev)', border: '1px solid var(--border)',
                     borderRadius: 6, padding: '8px 10px', cursor: 'pointer',
                     marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8,
                   }}>
                <span className="mono" style={{ fontSize: 12 }}>{flat(r.number)}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
                  {flat(r.short_description) || '—'}
                </span>
                <span style={{ fontSize: 11, color: 'var(--fg-4)' }}>{window.fmtRelative(flat(r.sys_updated_on))}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  // ServiceNow descriptions sometimes carry HTML. Strip script/style/event
  // handlers and let the rest render — formatting (bold, lists, links)
  // is part of how the catalog UI looks.
  function stripUnsafe(html) {
    return String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/\son\w+="[^"]*"/gi, '')
      .replace(/javascript:/gi, '');
  }

  function CatalogTabs({ tabs, active, onChange }) {
    return (
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 2, borderBottom: '1px solid var(--border-2)',
        marginBottom: 6,
      }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => onChange(t.id)}
            style={{
              padding: '6px 12px', fontSize: 12.5, fontWeight: 500,
              border: 'none', cursor: 'pointer', background: 'transparent',
              color: active === t.id ? 'var(--accent-fg)' : (t.r.missing ? 'var(--fg-4)' : 'var(--fg-2)'),
              borderBottom: active === t.id ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: -1,
            }}>
            {t.label}{' '}
            <span style={{ color: 'var(--fg-4)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
              {t.r.missing ? '(?)' : `(${t.r.total ?? t.r.rows?.length ?? 0})`}
            </span>
          </button>
        ))}
      </div>
    );
  }

  function ManifestFooterCat() {
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

  function Field({ label, children }) {
    return (
      <>
        <div style={{ color: 'var(--fg-3)', fontSize: 12 }}>{label}</div>
        <div style={{ fontSize: 12.5 }}>{children}</div>
      </>
    );
  }

  // ---- Tab bodies ------------------------------------------------------

  // ServiceNow variable type IDs → human label (subset).
  const VAR_TYPE_LABEL = {
    1: 'Single-line text', 2: 'Multi-line text', 5: 'Select box',
    6: 'Long text', 7: 'Reference', 8: 'Checkbox', 9: 'Date',
    11: 'Email', 16: 'Tree picker', 17: 'Tree picker', 18: 'Date/time',
    21: 'Email', 22: 'URL', 24: 'Lookup select', 26: 'Lookup multi-select',
    31: 'Label', 32: 'Container start', 33: 'Container end',
  };
  function variableTypeLabel(rec) {
    const t = flat(rec.type);
    if (t == null || t === '') return '—';
    const n = parseInt(t, 10);
    if (!isNaN(n) && VAR_TYPE_LABEL[n]) return VAR_TYPE_LABEL[n];
    return rec.__display_type || t;
  }

  function VariablesTab({ r }) {
    if (r.loading) return <Loading />;
    if (r.missing) return <NotInSnapshot table="item_option_new" />;
    if (!r.rows.length) return <Empty text="No variables defined for this catalog item." />;
    return (
      <table className="dt">
        <thead><tr>
          <th style={{ width: 40 }} className="num">#</th>
          <th style={{ width: 220 }}>Question label</th>
          <th style={{ width: 140 }}>Variable name</th>
          <th style={{ width: 150 }}>Type</th>
          <th style={{ width: 90 }}>Mandatory</th>
          <th>Reference / details</th>
        </tr></thead>
        <tbody>
          {r.rows.map(v => (
            <tr key={v.sys_id}>
              <td className="num mono" style={{ color: 'var(--fg-4)' }}>{flat(v.order) || '—'}</td>
              <td><strong style={{ fontWeight: 500 }}>{flat(v.question_text) || '(unlabeled)'}</strong></td>
              <td className="mono" style={{ fontSize: 11.5 }}>{flat(v.name)}</td>
              <td><span style={chip}>{variableTypeLabel(v)}</span></td>
              <td>{isTrue(flat(v.mandatory)) ? <span className="chip amber">required</span> : <span style={{ color: 'var(--fg-4)' }}>—</span>}</td>
              <td style={{ fontSize: 12 }}>
                {flat(v.reference) && <div className="mono" style={{ fontSize: 11 }}>→ {flat(v.reference)}</div>}
                {flat(v.default_value) && <div style={{ color: 'var(--fg-3)' }}>default: <span className="mono">{flat(v.default_value)}</span></div>}
                {flat(v.help_text) && <div style={{ color: 'var(--fg-4)', fontStyle: 'italic' }}>{flat(v.help_text)}</div>}
                {!flat(v.reference) && !flat(v.default_value) && !flat(v.help_text) && (
                  <span style={{ color: 'var(--fg-4)' }}>—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  function VariableSetsTab({ r }) {
    const [resolved, setResolved] = useState(null);
    useEffect(() => {
      if (!r || r.loading || r.missing || !r.rows.length) { setResolved([]); return; }
      let cancel = false;
      Promise.all(r.rows.map(row => C.fetchVariableSet(flat(row.variable_set))))
        .then(sets => { if (!cancel) setResolved(sets.filter(Boolean)); });
      return () => { cancel = true; };
    }, [r]);

    if (r.loading) return <Loading />;
    if (r.missing) return <NotInSnapshot table="io_set_item" />;
    if (!r.rows.length) return <Empty text="No variable sets attached to this catalog item." />;
    if (resolved === null) return <Loading label="Resolving variable sets…" />;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {resolved.map(s => (
          <div key={s.sys_id} style={{
            background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px',
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <strong style={{ fontWeight: 500 }}>{flat(s.title) || flat(s.internal_name) || '(unnamed)'}</strong>
              <span className="mono" style={{ fontSize: 11, color: 'var(--fg-4)' }}>{flat(s.internal_name)}</span>
              <span style={{ ...chip, marginLeft: 'auto' }}>{flat(s.layout) || 'standard'}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: 4 }}>{flat(s.description) || '—'}</div>
          </div>
        ))}
      </div>
    );
  }

  function UIPoliciesTab({ r, actions }) {
    // Compute the actions index unconditionally — the hooks-order rule
    // requires every render to call the same hooks in the same order, so
    // useMemo has to run before any conditional return. (Otherwise the
    // first "loading" render uses 0 hooks and the post-fetch render adds
    // one, blanking the tab with "Rendered more hooks than during the
    // previous render".)
    const actionsByPolicy = useMemo(() => {
      const m = new Map();
      for (const a of (actions?.rows || [])) {
        const k = flat(a.ui_policy);
        if (!k) continue;
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(a);
      }
      return m;
    }, [actions]);

    if (r.loading) return <Loading />;
    if (r.missing) return <NotInSnapshot table="catalog_ui_policy" />;
    if (!r.rows.length) return <Empty text="No UI policies defined." />;

    return (
      <table className="dt">
        <thead><tr>
          <th>Short description</th>
          <th style={{ width: 80 }} className="num">Order</th>
          <th style={{ width: 100 }}>On load</th>
          <th style={{ width: 100 }}>Reverse</th>
          <th style={{ width: 90 }}>Status</th>
        </tr></thead>
        <tbody>
          {r.rows.map(p => {
            const acts = actionsByPolicy.get(p.sys_id) || [];
            return (
              <tr key={p.sys_id}>
                <td>
                  <strong style={{ fontWeight: 500 }}>{flat(p.short_description) || '(no description)'}</strong>
                  {acts.length > 0 && (
                    <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {acts.map(a => {
                        const m = String(flat(a.mandatory) || 'leave_alone');
                        const v = String(flat(a.visible) || 'leave_alone');
                        const isReq = m === 'true';
                        return (
                          <span key={a.sys_id} style={{
                            ...chip,
                            background: isReq ? 'var(--c-amber-bg)' : 'var(--bg-3)',
                            borderColor: isReq ? 'var(--c-amber-border)' : 'var(--border)',
                            color: isReq ? 'var(--c-amber)' : 'var(--fg-2)',
                          }}>
                            {flat(a.variable) ? <span className="mono">{flat(a.variable).slice(0, 20)}</span> : '?'}: vis={v}, req={m}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </td>
                <td className="num mono">{flat(p.order) || '—'}</td>
                <td>{isTrue(flat(p.on_load)) ? <span className="chip green">yes</span> : <span className="chip">no</span>}</td>
                <td>{isTrue(flat(p.reverse_if_false)) ? <span className="chip">yes</span> : <span style={{ color: 'var(--fg-4)' }}>—</span>}</td>
                <td>{isTrue(flat(p.active)) ? <span className="chip green">active</span> : <span className="chip">inactive</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }

  function ClientScriptsTab({ r }) {
    if (r.loading) return <Loading />;
    if (r.missing) return <NotInSnapshot table="catalog_script_client" />;
    if (!r.rows.length) return <Empty text="No client scripts defined." />;
    const typeColor = { onLoad: 'var(--c-blue)', onChange: 'var(--c-amber)', onSubmit: 'var(--c-violet)' };
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {r.rows.map(s => {
          const t = dv(s, 'type') || flat(s.type) || '—';
          const script = flat(s.script) || flat(s.script_preview) || '';
          return (
            <div key={s.sys_id} style={{
              background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ ...chip, color: typeColor[t] || 'var(--fg-2)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{t}</span>
                <strong style={{ fontWeight: 500 }}>{flat(s.name) || '(unnamed)'}</strong>
                <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-4)' }}>
                  {flat(s.cat_variable) ? `applies to: ${flat(s.cat_variable)}` : ''}
                </span>
              </div>
              {script && (
                <pre style={{
                  margin: '8px 0 0', padding: '8px 10px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
                  fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--fg-2)', overflowX: 'auto',
                  whiteSpace: 'pre-wrap', maxHeight: 320,
                }}>{script}</pre>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  function UserCriteriaTab({ r, kind }) {
    const [resolved, setResolved] = useState(null);
    useEffect(() => {
      if (!r || r.loading || r.missing || !r.rows.length) { setResolved([]); return; }
      let cancel = false;
      Promise.all(r.rows.map(row => C.fetchUserCriterion(flat(row.user_criteria))))
        .then(crits => { if (!cancel) setResolved(crits.filter(Boolean)); });
      return () => { cancel = true; };
    }, [r]);

    if (r.loading) return <Loading />;
    if (r.missing) return <NotInSnapshot table={kind === 'allow' ? 'sc_cat_item_user_criteria_mtom' : 'sc_cat_item_user_criteria_no_mtom'} />;
    if (!r.rows.length) return <Empty text={kind === 'allow' ? 'No "Available For" entries — visible to everyone in the catalog.' : 'No "Not Available For" entries.'} />;
    if (resolved === null) return <Loading label="Resolving user criteria…" />;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {resolved.map(uc => (
          <div key={uc.sys_id} style={{
            background: kind === 'deny' ? 'var(--c-red-bg)' : 'var(--accent-bg)',
            border: '1px solid ' + (kind === 'deny' ? 'var(--c-red-border)' : 'var(--accent-border)'),
            borderRadius: 8, padding: '8px 12px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <window.Icon name={kind === 'deny' ? 'lock' : 'shield'} size={12} />
              <strong style={{ fontWeight: 500 }}>{flat(uc.name) || '(unnamed criterion)'}</strong>
              {isTrue(flat(uc.advanced)) && <span style={{ ...chip, marginLeft: 'auto' }}>advanced (script)</span>}
            </div>
            {flat(uc.description) && (
              <div style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: 4 }}>{flat(uc.description)}</div>
            )}
          </div>
        ))}
      </div>
    );
  }

  function CategoriesTab({ name, sys_id }) {
    const [cat, setCat] = useState(null);
    useEffect(() => {
      if (!sys_id) { setCat(false); return; }
      C.fetchCategory(sys_id).then(setCat).catch(() => setCat(false));
    }, [sys_id]);
    if (!sys_id || name === '—') return <Empty text="Item is not assigned to a category." />;
    return (
      <div style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <strong style={{ fontWeight: 500 }}>{name}</strong>
          <span className="mono" style={{ fontSize: 11, color: 'var(--fg-4)' }}>sc_category</span>
          {cat === null && <span style={{ marginLeft: 'auto', color: 'var(--fg-4)', fontSize: 11 }}>loading…</span>}
        </div>
        {cat && cat !== false && flat(cat.description) && (
          <div style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: 4 }}>{flat(cat.description)}</div>
        )}
        {cat === false && (
          <div style={{ fontSize: 11.5, color: 'var(--fg-4)', marginTop: 4, fontStyle: 'italic' }}>
            Category sys_id present on item, but the sc_category record isn't in this snapshot — pull sc_category from the exporter to enrich.
          </div>
        )}
      </div>
    );
  }

  function CatalogsTab({ name, sys_id }) {
    const [cat, setCat] = useState(null);
    useEffect(() => {
      if (!sys_id) { setCat(false); return; }
      C.fetchCatalog(sys_id).then(setCat).catch(() => setCat(false));
    }, [sys_id]);
    if (!sys_id || name === '—') return <Empty text="Item is not assigned to a catalog." />;
    return (
      <div style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <strong style={{ fontWeight: 500 }}>{name}</strong>
          <span className="mono" style={{ fontSize: 11, color: 'var(--fg-4)' }}>sc_catalog</span>
          {cat === null && <span style={{ marginLeft: 'auto', color: 'var(--fg-4)', fontSize: 11 }}>loading…</span>}
        </div>
        {cat && cat !== false && flat(cat.description) && (
          <div style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: 4 }}>{flat(cat.description)}</div>
        )}
        {cat === false && (
          <div style={{ fontSize: 11.5, color: 'var(--fg-4)', marginTop: 4, fontStyle: 'italic' }}>
            Catalog sys_id present on item, but the sc_catalog record isn't in this snapshot — pull sc_catalog from the exporter to enrich.
          </div>
        )}
      </div>
    );
  }
})();
