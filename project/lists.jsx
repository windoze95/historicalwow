/* eslint-disable */
// List views — paginated API queries against /api/<table>.
//
// No table is "eager-loaded into memory and filtered client-side" anymore;
// each list view does its own paginated fetch with the current filter / search.

// Friendly labels for sidebar / breadcrumbs / page titles.
window.TASK_LABELS = {
  incident:          { plural: 'Incidents',         singular: 'Incident' },
  change_request:    { plural: 'Change requests',   singular: 'Change request' },
  problem:           { plural: 'Problems',          singular: 'Problem' },
  problem_task:      { plural: 'Problem tasks',     singular: 'Problem task' },
  sc_request:        { plural: 'Requests',          singular: 'Request' },
  sc_req_item:       { plural: 'Requested items',   singular: 'Requested item' },
  sc_task:           { plural: 'Catalog tasks',     singular: 'Catalog task' },
  sysapproval_group: { plural: 'Group approvals',   singular: 'Group approval' },
  asset_task:        { plural: 'Asset tasks',       singular: 'Asset task' },
  sn_contract_renewal_task: { plural: 'Contract renewal tasks', singular: 'Contract renewal task' },
  incident_task:     { plural: 'Incident tasks',    singular: 'Incident task' },
  change_task:       { plural: 'Change tasks',      singular: 'Change task' },
  alm_asset:           { plural: 'Assets',            singular: 'Asset' },
  alm_hardware:        { plural: 'Hardware',          singular: 'Hardware asset' },
  alm_software_license:{ plural: 'Software licenses', singular: 'Software license' },
  alm_license:         { plural: 'Licenses',          singular: 'License' },
  alm_consumable:      { plural: 'Consumables',       singular: 'Consumable' },
  alm_facility:        { plural: 'Facilities',        singular: 'Facility' },
  alm_stockroom:       { plural: 'Stockrooms',        singular: 'Stockroom' },
  sn_ent_facility_asset:{ plural: 'Facility assets', singular: 'Facility asset' },
  cmdb_ci_spkg:        { plural: 'Software packages', singular: 'Software package' },
  cmdb_software_instance: { plural: 'Software installs', singular: 'Software install' },
};
window.taskLabel = function (table, mode = 'plural') {
  const e = window.TASK_LABELS[table];
  if (e) return e[mode];
  const text = table.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

const PAGE_SIZE = 50;

const ASSET_TABLES = [
  'alm_asset', 'alm_hardware', 'alm_software_license', 'alm_license',
  'alm_consumable', 'alm_facility', 'alm_stockroom',
  'sn_ent_facility_asset',
  'cmdb_ci_spkg', 'cmdb_software_instance',
];

const ListPage = window.ListPage = function ListPage({ table }) {
  if (table === 'sys_user')        return <UserList />;
  if (table === 'sys_user_group')  return <GroupList />;
  if (table === 'sys_user_delegate') return <DelegateList />;
  if (table === 'kb_knowledge')    return <KBListPage />;
  if (table === 'sysevent_in_email_action') return <EmailActionList table="sysevent_in_email_action" targetField="table" title="Inbound email actions" />;
  if (table === 'sysevent_email_action')    return <EmailActionList table="sysevent_email_action" targetField="collection" title="Notifications" />;
  if (table === 'cmdb_ci')         return <CIList />;
  if (ASSET_TABLES.includes(table)) return <AssetList key={table} table={table} />;
  if (window.TASK_TABLES && window.TASK_TABLES.includes(table)) {
    return <TaskList key={table} table={table} />;
  }
  return null;
};

// ---- generic paginated task list (fetches via /api/<table>) ---------------

function TaskList({ table }) {
  const data = window.HistoricalWowData;
  const [q, setQ] = React.useState('');
  const [debouncedQ, setDebouncedQ] = React.useState('');
  const [page, setPage] = React.useState(0);
  const [resp, setResp] = React.useState({ rows: null, total: 0 });
  const [loading, setLoading] = React.useState(true);

  // Debounce q so we don't fire a query on every keystroke
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  // Reset to page 0 on q change
  React.useEffect(() => { setPage(0); }, [debouncedQ, table]);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    data.fetchTaskList(table, {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      q: debouncedQ,
      // Full envelope (not slim) so reference fields carry __display_<field>
      // for cases where findUser/findGroup miss in the lookup map.
      order_by: 'sys_updated_on',
      dir: 'desc',
    }).then(r => {
      if (cancelled) return;
      setResp(r);
      setLoading(false);
    }).catch(e => {
      if (cancelled) return;
      console.warn('TaskList fetch failed:', e);
      setResp({ rows: [], total: 0 });
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [table, debouncedQ, page]);

  const label = window.taskLabel(table, 'plural');
  const manifestEntry = data.manifest.tables.find(t => t.table === table);
  const sourceCount = manifestEntry ? manifestEntry.source_rows.toLocaleString() : '?';
  const total = resp.total || 0;
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  return (
    <div>
      <div className="page-header">
        <h1>{label} <span className="count mono">{sourceCount}</span></h1>
        <div className="sub">
          <span className="mono" style={{ color: 'var(--fg-4)' }}>{table}</span> ·
          {' '}{total.toLocaleString()} matching · page {page + 1} of {lastPage + 1}
        </div>
        <div className="toolbar">
          <div className="spacer" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search number or short description…"
            style={{ height: 26, padding: '0 10px', border: '1px solid var(--border-2)', borderRadius: 14, background: 'var(--bg-elev)', fontSize: 12, outline: 'none', width: 280 }} />
          <Pager page={page} setPage={setPage} lastPage={lastPage} />
        </div>
      </div>
      <table className="dt">
        <thead>
          <tr>
            <th style={{ width: 130 }}>Number</th>
            <th>Short description</th>
            <th style={{ width: 110 }}>Priority</th>
            <th style={{ width: 130 }}>State</th>
            <th style={{ width: 180 }}>Assigned to</th>
            <th style={{ width: 170 }}>Group</th>
            <th style={{ width: 130 }} className="num">Updated</th>
          </tr>
        </thead>
        <tbody>
          {loading && (resp.rows == null) && (
            <tr><td colSpan={7} style={{ padding: '60px 20px', color: 'var(--fg-4)', textAlign: 'center' }}>
              <span className="dot-pulse" style={{ display: 'inline-block', marginRight: 8 }} />
              loading…
            </td></tr>
          )}
          {!loading && resp.rows && resp.rows.length === 0 && (
            <tr><td colSpan={7} style={{ padding: '40px 20px', color: 'var(--fg-4)', textAlign: 'center' }}>
              No matching records.
            </td></tr>
          )}
          {(resp.rows || []).map(r => {
            const stDec = window.decodeChoice('incident', 'state', r.state);
            const prDec = window.decodeChoice('incident', 'priority', r.priority);
            const bars = window.priorityBars(r.priority);
            return (
              <tr key={r.sys_id} onClick={() => window.navigate(window.recordUrl(table, r.sys_id))}>
                <td className="num">{r.number || r.sys_id?.slice(0, 8)}</td>
                <td className="short"><span className="truncate">{r.short_description || '—'}</span></td>
                <td>
                  {r.priority ? (
                    <span className={`chip ${window.priorityChipClass(r.priority)}`} title={prDec.label}>
                      <span className={`priority-bar ${bars.cls}`}>
                        {[0,1,2,3,4].map(i => <span key={i} className={'b' + (i < bars.filled ? ' on' : '')} style={{ height: 4 + i * 2 }} />)}
                      </span>
                      {prDec.label.split(' — ')[0] || `P${r.priority}`}
                    </span>
                  ) : <span className="muted">—</span>}
                </td>
                <td>
                  {r.state
                    ? <span className={`chip ${window.stateChipClass('incident', r.state)}`}>{stDec.label || r.state}</span>
                    : <span className="muted">—</span>}
                </td>
                <td>{r.assigned_to ? <window.UserCell sys_id={r.assigned_to} displayName={r.__display_assigned_to} /> : <span className="muted">—</span>}</td>
                <td className="muted">{window.findGroup(r.assignment_group)?.name || r.__display_assignment_group || '—'}</td>
                <td className="num muted" title={r.sys_updated_on}>{window.fmtRelative(r.sys_updated_on)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Pager({ page, setPage, lastPage }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
      <button className="filter-pill" disabled={page === 0}
        onClick={() => setPage(0)}>« first</button>
      <button className="filter-pill" disabled={page === 0}
        onClick={() => setPage(p => Math.max(0, p - 1))}>‹ prev</button>
      <button className="filter-pill" disabled={page >= lastPage}
        onClick={() => setPage(p => Math.min(lastPage, p + 1))}>next ›</button>
      <button className="filter-pill" disabled={page >= lastPage}
        onClick={() => setPage(lastPage)}>last »</button>
    </div>
  );
}

// ---- Assets (alm_* family) ----------------------------------------------
// Per-table column choices so each subtype renders the fields you'd
// actually look up: serial+model for hardware, vendor+expiration for
// licenses, etc. Uses the generic /api/<table> endpoint with the same
// pagination/search shape as TaskList.

const ASSET_COLS = {
  alm_hardware: [
    { key: 'asset_tag',     label: 'Asset tag',      cls: 'num',  w: 110 },
    { key: 'display_name',  label: 'Name',           grow: true },
    { key: 'serial_number', label: 'Serial',         cls: 'num',  w: 140 },
    { key: 'model',         label: 'Model',          ref: 'cmdb_ci' },
    { key: 'state',         label: 'Status',         choice: ['alm_asset', 'install_status'], w: 110 },
    { key: 'assigned_to',   label: 'Assigned to',    ref: 'user', w: 180 },
  ],
  sn_ent_facility_asset: [
    { key: 'asset_tag',     label: 'Asset tag',      cls: 'mono', w: 160 },
    { key: 'display_name',  label: 'Name',           grow: true },
    { key: 'model',         label: 'Model',          ref: 'cmdb_ci' },
    { key: 'state',         label: 'Status',         choice: ['alm_asset', 'install_status'], w: 110 },
    { key: 'location',      label: 'Location',       ref: 'location', w: 180 },
  ],
  alm_software_license: [
    { key: 'asset_tag',     label: 'Asset tag',      cls: 'num',  w: 110 },
    { key: 'display_name',  label: 'License',        grow: true },
    { key: 'vendor',        label: 'Vendor',         ref: 'company', w: 160 },
    { key: 'license_count', label: 'Seats',          cls: 'num',  w: 70 },
    { key: 'expiration_date', label: 'Expires',      w: 110 },
    { key: 'state',         label: 'Status',         choice: ['alm_asset', 'install_status'], w: 110 },
  ],
  alm_consumable: [
    { key: 'asset_tag',     label: 'Asset tag', cls: 'num', w: 110 },
    { key: 'display_name',  label: 'Name', grow: true },
    { key: 'quantity',      label: 'Qty', cls: 'num', w: 70 },
    { key: 'model',         label: 'Model', ref: 'cmdb_ci' },
    { key: 'location',      label: 'Location', ref: 'location', w: 180 },
    { key: 'state',         label: 'Status', choice: ['alm_asset', 'install_status'], w: 110 },
  ],
  alm_facility: [
    { key: 'asset_tag',     label: 'Asset tag', cls: 'num', w: 110 },
    { key: 'display_name',  label: 'Name', grow: true },
    { key: 'location',      label: 'Location', ref: 'location', w: 180 },
    { key: 'state',         label: 'Status', choice: ['alm_asset', 'install_status'], w: 110 },
  ],
  alm_stockroom: [
    { key: 'name',          label: 'Name', grow: true },
    { key: 'display_name',  label: 'Display name' },
    { key: 'location',      label: 'Location', ref: 'location', w: 180 },
    { key: 'manager',       label: 'Manager', ref: 'user', w: 180 },
  ],
  alm_asset: [
    { key: 'asset_tag',     label: 'Asset tag', cls: 'num', w: 110 },
    { key: 'display_name',  label: 'Name', grow: true },
    { key: 'sys_class_name',label: 'Class', cls: 'mono', w: 160 },
    { key: 'state',         label: 'Status', choice: ['alm_asset', 'install_status'], w: 110 },
    { key: 'assigned_to',   label: 'Assigned to', ref: 'user', w: 180 },
  ],
  alm_license: [
    { key: 'asset_tag',     label: 'Asset tag', cls: 'num', w: 110 },
    { key: 'display_name',  label: 'License', grow: true },
    { key: 'vendor',        label: 'Vendor', ref: 'company', w: 160 },
    { key: 'license_count', label: 'Seats',  cls: 'num',     w: 70 },
    { key: 'expiration_date', label: 'Expires',              w: 110 },
    { key: 'state',         label: 'Status', choice: ['alm_asset', 'install_status'], w: 110 },
  ],
  cmdb_ci_spkg: [
    { key: 'name',          label: 'Software',  grow: true },
    { key: 'version',       label: 'Version',   cls: 'mono', w: 110 },
    { key: 'manufacturer',  label: 'Manufacturer', ref: 'company', w: 160 },
    { key: 'edition',       label: 'Edition',   w: 140 },
    { key: 'sys_class_name',label: 'Class',     cls: 'mono', w: 160 },
  ],
  cmdb_software_instance: [
    { key: 'display_name',  label: 'Software',  grow: true },
    { key: 'version',       label: 'Version',   cls: 'mono', w: 110 },
    { key: 'ci',            label: 'Installed on', ref: 'cmdb_ci', w: 220 },
    { key: 'install_date',  label: 'Installed', w: 110 },
    { key: 'install_status',label: 'Status',    w: 110 },
  ],
};

function AssetList({ table }) {
  const data = window.HistoricalWowData;
  const [q, setQ] = React.useState('');
  const [debouncedQ, setDebouncedQ] = React.useState('');
  const [page, setPage] = React.useState(0);
  const [resp, setResp] = React.useState({ rows: null, total: 0 });
  const [loading, setLoading] = React.useState(true);
  const cols = ASSET_COLS[table] || ASSET_COLS.alm_asset;

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  React.useEffect(() => { setPage(0); }, [debouncedQ, table]);

  React.useEffect(() => {
    let cancel = false;
    setLoading(true);
    data.fetchTaskList(table, {
      limit: PAGE_SIZE, offset: page * PAGE_SIZE,
      q: debouncedQ || undefined,
      order_by: 'sys_updated_on', dir: 'desc',
    }).then(r => { if (!cancel) { setResp(r); setLoading(false); } })
      .catch(() => { if (!cancel) { setResp({ rows: [], total: 0 }); setLoading(false); } });
    return () => { cancel = true; };
  }, [page, debouncedQ, table]);

  const renderCell = (row, col) => {
    const v = row[col.key];
    if (col.ref === 'user') {
      return v ? <window.UserCell sys_id={v} displayName={row['__display_' + col.key]} /> : <span className="muted">—</span>;
    }
    if (col.ref === 'company') {
      const c = window.findCompany?.(v);
      return c?.name || row['__display_' + col.key] || (v ? <span className="mono" style={{ fontSize: 11.5 }}>{String(v).slice(0, 8)}…</span> : '—');
    }
    if (col.ref === 'location') {
      const l = window.findLocation?.(v);
      return l?.name || row['__display_' + col.key] || '—';
    }
    if (col.ref === 'cmdb_ci') {
      const ci = window.findCI?.(v);
      return ci?.name || row['__display_' + col.key] || (v ? <span className="mono" style={{ fontSize: 11.5 }}>{String(v).slice(0, 8)}…</span> : '—');
    }
    if (col.choice) {
      const decoded = window.decodeChoice(col.choice[0], col.choice[1], v);
      return v ? <span className={`chip ${window.stateChipClass('incident', v)}`}>{decoded.label || v}</span> : '—';
    }
    return v != null && v !== '' ? String(v) : <span className="muted">—</span>;
  };

  const lastPage = Math.max(0, Math.ceil(resp.total / PAGE_SIZE) - 1);
  const label = window.taskLabel(table, 'plural');

  return (
    <div>
      <div className="page-header">
        <h1>{label} <span className="count mono">{resp.total.toLocaleString()}</span></h1>
        <div className="sub">
          <span className="mono" style={{ color: 'var(--fg-4)' }}>{table}</span> · page {page + 1} of {lastPage + 1}
        </div>
        <div className="toolbar">
          <div className="spacer" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search asset tag, name, serial…"
            style={{ height: 26, padding: '0 10px', border: '1px solid var(--border-2)', borderRadius: 14, background: 'var(--bg-elev)', fontSize: 12, outline: 'none', width: 280 }} />
        </div>
      </div>
      <table className="dt">
        <thead><tr>
          {cols.map(c => (
            <th key={c.key} className={c.cls || ''} style={c.w ? { width: c.w } : undefined}>{c.label}</th>
          ))}
        </tr></thead>
        <tbody>
          {loading && resp.rows == null && (
            <tr><td colSpan={cols.length} style={{ padding: '24px 12px', color: 'var(--fg-4)', textAlign: 'center' }}>
              <span className="dot-pulse" style={{ display: 'inline-block', marginRight: 8 }} />loading…
            </td></tr>
          )}
          {!loading && (resp.rows || []).length === 0 && (
            <tr><td colSpan={cols.length} style={{ padding: '24px 12px', color: 'var(--fg-4)', textAlign: 'center' }}>No matching assets.</td></tr>
          )}
          {(resp.rows || []).map(r => (
            <tr key={r.sys_id} onClick={() => window.navigate(window.recordUrl(table, r.sys_id))}>
              {cols.map(c => (
                <td key={c.key} className={c.cls || ''}>{renderCell(r, c)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '12px 0' }}>
        <button className="filter-pill" disabled={page === 0}
          onClick={() => setPage(0)}>« first</button>
        <button className="filter-pill" disabled={page === 0}
          onClick={() => setPage(p => Math.max(0, p - 1))}>‹ prev</button>
        <span style={{ fontSize: 12, color: 'var(--fg-3)', padding: '0 12px' }}>page {page + 1} of {lastPage + 1}</span>
        <button className="filter-pill" disabled={page >= lastPage}
          onClick={() => setPage(p => Math.min(lastPage, p + 1))}>next ›</button>
        <button className="filter-pill" disabled={page >= lastPage}
          onClick={() => setPage(lastPage)}>last »</button>
      </div>
    </div>
  );
}

// ---- Users ---------------------------------------------------------------

function UserList() {
  const data = window.HistoricalWowData;
  const [q, setQ] = React.useState('');
  // sys_user isn't eager-loaded as an array anymore (saves ~5 MB of envelope
  // payload at boot); the compact projection lives in data.sys_user_lookup
  // (Map of sys_id → {name, user_name, title, department, location}). Walk
  // it to build the list rows.
  const allRows = React.useMemo(() => {
    const out = [];
    for (const [sys_id, info] of data.sys_user_lookup) {
      out.push({ sys_id, ...info });
    }
    return out;
  }, [data.sys_user_lookup]);

  let rows = allRows;
  if (q.trim()) {
    const ql = q.toLowerCase();
    rows = rows.filter(r =>
      (r.name || '').toLowerCase().includes(ql) ||
      (r.user_name || '').toLowerCase().includes(ql) ||
      (r.title || '').toLowerCase().includes(ql)
    );
  }
  rows = rows.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const display = rows.slice(0, 500);  // cap render for perf

  return (
    <div>
      <div className="page-header">
        <h1>Users <span className="count mono">{data.manifest.tables.find(t => t.table === 'sys_user')?.source_rows?.toLocaleString() || '—'}</span></h1>
        <div className="sub"><span className="mono" style={{ color: 'var(--fg-4)' }}>sys_user</span> · {rows.length.toLocaleString()} of {allRows.length.toLocaleString()} loaded</div>
        <div className="toolbar">
          <div className="spacer" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter…"
            style={{ height: 26, padding: '0 10px', border: '1px solid var(--border-2)', borderRadius: 14, background: 'var(--bg-elev)', fontSize: 12, outline: 'none', width: 240 }} />
        </div>
      </div>
      <table className="dt">
        <thead><tr>
          <th>Name</th><th>User name</th><th>Title</th><th>Department</th><th>Location</th>
        </tr></thead>
        <tbody>
          {display.map(u => (
            <tr key={u.sys_id} onClick={() => window.navigate(`/users/${u.sys_id}`)}>
              <td><window.UserCell sys_id={u.sys_id} asLink={false} /></td>
              <td className="num">{u.user_name}</td>
              <td>{u.title}</td>
              <td className="muted">{window.findDepartment(u.department)?.name || '—'}</td>
              <td className="muted">{window.findLocation(u.location)?.name || '—'}</td>
            </tr>
          ))}
          {rows.length > display.length && (
            <tr><td colSpan={5} style={{ padding: 14, color: 'var(--fg-4)', textAlign: 'center', fontSize: 12 }}>
              {(rows.length - display.length).toLocaleString()} more — refine the filter to see them.
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---- Groups ---------------------------------------------------------------

function GroupList() {
  const data = window.HistoricalWowData;
  const rows = data.sys_user_group.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return (
    <div>
      <div className="page-header">
        <h1>Groups <span className="count mono">{data.manifest.tables.find(t => t.table === 'sys_user_group')?.source_rows?.toLocaleString() || '—'}</span></h1>
        <div className="sub"><span className="mono" style={{ color: 'var(--fg-4)' }}>sys_user_group</span> · {data.sys_user_group.length} loaded</div>
      </div>
      <table className="dt">
        <thead><tr>
          <th>Name</th><th>Manager</th><th style={{ width: 100 }} className="num">Members</th><th>Description</th>
        </tr></thead>
        <tbody>
          {rows.map(g => (
            <tr key={g.sys_id} onClick={() => window.navigate(`/groups/${g.sys_id}`)}>
              <td><strong style={{ fontWeight: 500 }}>{g.name}</strong></td>
              <td>{g.manager ? <window.UserCell sys_id={g.manager} displayName={g.__display_manager} /> : <span className="muted">—</span>}</td>
              <td className="num">{(g.member_sys_ids || []).length}</td>
              <td className="muted">{g.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- Delegations ----------------------------------------------------------
// sys_user_delegate isn't eager-loaded, so fetch it from the API. Paginated
// like CIList so a snapshot with more delegations than one page still shows
// every row (no silent truncation). Renders the same delegator → delegate /
// window / scopes shape as the user-page panel.

function DelegateList() {
  const data = window.HistoricalWowData;
  const [page, setPage] = React.useState(0);
  const [resp, setResp] = React.useState({ rows: null, total: 0 });
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    data.fetchTaskList('sys_user_delegate', {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      order_by: 'starts', dir: 'desc',
    }).then(r => {
      if (cancelled) return;
      setResp(r); setLoading(false);
    }).catch(() => {
      if (cancelled) return;
      setResp({ rows: [], total: 0 }); setLoading(false);
    });
    return () => { cancelled = true; };
  }, [page]);

  const total = resp.total || 0;
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
  const headerCount = data.manifest.tables.find(t => t.table === 'sys_user_delegate')?.source_rows;
  const scopes = window.DELEGATION_SCOPES || [];
  const on = window.delegationOn || (v => v === true || v === 'true' || v === 1 || v === '1');

  return (
    <div>
      <div className="page-header">
        <h1>Delegations <span className="count mono">{headerCount?.toLocaleString() || total.toLocaleString()}</span></h1>
        <div className="sub"><span className="mono" style={{ color: 'var(--fg-4)' }}>sys_user_delegate</span> · who acts on whose behalf, and for what · page {page + 1} of {lastPage + 1}</div>
        <div className="toolbar">
          <div className="spacer" />
          <Pager page={page} setPage={setPage} lastPage={lastPage} />
        </div>
      </div>
      <table className="dt">
        <thead><tr>
          <th>Delegator</th><th>Delegate</th>
          <th style={{ width: 150 }}>Starts</th><th style={{ width: 150 }}>Ends</th>
          <th>Scopes</th>
        </tr></thead>
        <tbody>
          {loading && resp.rows == null && (
            <tr><td colSpan={5} style={{ padding: 60, color: 'var(--fg-4)', textAlign: 'center' }}>
              <span className="dot-pulse" style={{ display: 'inline-block', marginRight: 8 }} />loading…
            </td></tr>
          )}
          {!loading && resp.rows && resp.rows.length === 0 && (
            <tr><td colSpan={5} style={{ padding: 40, color: 'var(--fg-4)', textAlign: 'center' }}>No delegations in this snapshot.</td></tr>
          )}
          {(resp.rows || []).map(d => {
            const active = scopes.filter(([k]) => on(d[k]));
            return (
              <tr key={d.sys_id}>
                <td>{d.user ? <window.UserCell sys_id={d.user} displayName={d.__display_user} /> : <span className="muted">—</span>}</td>
                <td>{d.delegate ? <window.UserCell sys_id={d.delegate} displayName={d.__display_delegate} /> : <span className="muted">—</span>}</td>
                <td className="mono" style={{ fontSize: 12 }}>{d.starts || '—'}</td>
                <td className="mono" style={{ fontSize: 12 }}>{d.ends || 'open'}</td>
                <td>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {active.length === 0
                      ? <span className="muted" style={{ fontSize: 11.5 }}>—</span>
                      : active.map(([k, label]) => <span key={k} className="chip" style={{ fontSize: 10.5 }}>{label}</span>)}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---- Knowledge base -------------------------------------------------------
// kb_knowledge isn't eager-loaded; paginate via the API like CIList. The list
// links to a dedicated article view; the record page renders the article HTML.

function KBListPage() {
  const data = window.HistoricalWowData;
  const [page, setPage] = React.useState(0);
  const [resp, setResp] = React.useState({ rows: null, total: 0 });
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // slim=1 → indexed columns only, skipping the raw envelope (which for
    // kb_knowledge carries the full article `text` body). The list only shows
    // metadata; the body is fetched lazily in KBRecordPage.
    data.fetchTaskList('kb_knowledge', { limit: PAGE_SIZE, offset: page * PAGE_SIZE, order_by: 'number', dir: 'desc', slim: 1 })
      .then(r => { if (!cancelled) { setResp(r); setLoading(false); } })
      .catch(() => { if (!cancelled) { setResp({ rows: [], total: 0 }); setLoading(false); } });
    return () => { cancelled = true; };
  }, [page]);

  const total = resp.total || 0;
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
  const headerCount = data.manifest.tables.find(t => t.table === 'kb_knowledge')?.source_rows;

  return (
    <div>
      <div className="page-header">
        <h1>Knowledge <span className="count mono">{headerCount?.toLocaleString() || total.toLocaleString()}</span></h1>
        <div className="sub"><span className="mono" style={{ color: 'var(--fg-4)' }}>kb_knowledge</span> · articles &amp; drafts · page {page + 1} of {lastPage + 1}</div>
        <div className="toolbar"><div className="spacer" /><Pager page={page} setPage={setPage} lastPage={lastPage} /></div>
      </div>
      <table className="dt">
        <thead><tr>
          <th style={{ width: 130 }}>Number</th><th>Short description</th>
          <th style={{ width: 140 }}>State</th><th style={{ width: 220 }}>Author</th>
        </tr></thead>
        <tbody>
          {loading && resp.rows == null && (
            <tr><td colSpan={4} style={{ padding: 60, color: 'var(--fg-4)', textAlign: 'center' }}>
              <span className="dot-pulse" style={{ display: 'inline-block', marginRight: 8 }} />loading…
            </td></tr>
          )}
          {!loading && resp.rows && resp.rows.length === 0 && (
            <tr><td colSpan={4} style={{ padding: 40, color: 'var(--fg-4)', textAlign: 'center' }}>No articles.</td></tr>
          )}
          {(resp.rows || []).map(a => (
            <tr key={a.sys_id} onClick={() => window.navigate(`/knowledge/${a.sys_id}`)}>
              <td className="num mono" style={{ fontSize: 12 }}>{a.number}</td>
              <td><strong style={{ fontWeight: 500 }}>{a.short_description}</strong></td>
              <td>{a.workflow_state ? <span className="chip" style={{ fontSize: 10.5 }}>{a.workflow_state}</span> : <span className="muted">—</span>}</td>
              <td>{a.author ? <window.UserCell sys_id={a.author} displayName={a.__display_author} /> : <span className="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

window.KBRecordPage = function KBRecordPage({ sys_id }) {
  const data = window.HistoricalWowData;
  const [rec, setRec] = React.useState(undefined);  // undefined = loading, null = not found
  React.useEffect(() => {
    let cancel = false;
    data.fetchRecord('kb_knowledge', sys_id)
      .then(r => { if (!cancel) setRec(r || null); })
      .catch(() => { if (!cancel) setRec(null); });
    if (window.AuditLog) window.AuditLog.push('view', `kb_knowledge/${sys_id}`, '');
    return () => { cancel = true; };
  }, [sys_id]);

  if (rec === undefined) return <div style={{ padding: 24, color: 'var(--fg-4)', fontSize: 12.5 }}><span className="dot-pulse" style={{ display: 'inline-block', marginRight: 8 }} />loading…</div>;
  if (!rec) return <div className="empty"><div className="glyph"><window.Icon name="info" /></div>Article not in this snapshot.</div>;
  const dval = (k) => rec['__display_' + k] || rec[k];

  return (
    <div className="ref-page">
      <div className="crumbs" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--fg-3)', marginBottom: 14 }}>
        <a onClick={() => window.navigate('/knowledge')}>Knowledge</a>
        <window.Icon name="chevron_right" size={11} />
        <span className="mono">{rec.number}</span>
      </div>
      <div className="head" style={{ display: 'block' }}>
        <h1 style={{ marginBottom: 8 }}>{rec.short_description || '(untitled)'}</h1>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {rec.workflow_state && <span className="chip">{dval('workflow_state')}</span>}
          {rec.article_type && <span className="chip">{dval('article_type')}</span>}
          {rec.active === false && <span className="chip" style={{ color: 'var(--fg-4)' }}>inactive</span>}
        </div>
      </div>
      <div className="ref-grid" style={{ marginTop: 14 }}>
        <div className="cell"><div className="label">Number</div><div className="val mono">{rec.number || '—'}</div></div>
        <div className="cell"><div className="label">Knowledge base</div><div className="val">{dval('kb_knowledge_base') || '—'}</div></div>
        <div className="cell"><div className="label">Category</div><div className="val">{dval('kb_category') || dval('category') || '—'}</div></div>
        <div className="cell"><div className="label">Author</div><div className="val">{rec.author ? <window.UserCell sys_id={rec.author} displayName={rec.__display_author} /> : '—'}</div></div>
        <div className="cell"><div className="label">Published</div><div className="val">{rec.published || '—'}</div></div>
        <div className="cell"><div className="label">Valid to</div><div className="val">{rec.valid_to || '—'}</div></div>
        <div className="cell"><div className="label">Views</div><div className="val">{rec.sys_view_count || '0'}</div></div>
        <div className="cell"><div className="label">Updated</div><div className="val">{rec.sys_updated_on || '—'}</div></div>
      </div>
      <div className="ref-section">
        <h2>Article</h2>
        {rec.text
          ? <iframe title="KB article" sandbox="" srcDoc={rec.text}
              style={{ width: '100%', height: '70vh', border: '1px solid var(--border)', borderRadius: 8, background: '#fff' }} />
          : <div style={{ color: 'var(--fg-4)', fontSize: 12.5 }}>No article body in this snapshot.</div>}
      </div>
    </div>
  );
};

// ---- Email actions (inbound rules + outbound notifications) ---------------
// Shared list for sysevent_in_email_action (targetField 'table') and
// sysevent_email_action (targetField 'collection'). slim — only indexed
// metadata is shown, skipping the (large) message/script bodies in raw.
function EmailActionList({ table, targetField, title }) {
  const data = window.HistoricalWowData;
  const [page, setPage] = React.useState(0);
  const [resp, setResp] = React.useState({ rows: null, total: 0 });
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    data.fetchTaskList(table, { limit: PAGE_SIZE, offset: page * PAGE_SIZE, order_by: 'name', dir: 'asc', slim: 1 })
      .then(r => { if (!cancelled) { setResp(r); setLoading(false); } })
      .catch(() => { if (!cancelled) { setResp({ rows: [], total: 0 }); setLoading(false); } });
    return () => { cancelled = true; };
  }, [table, page]);

  const total = resp.total || 0;
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
  const headerCount = data.manifest.tables.find(t => t.table === table)?.source_rows;
  const isOn = v => v === true || v === 'true' || v === 1 || v === '1';

  return (
    <div>
      <div className="page-header">
        <h1>{title} <span className="count mono">{headerCount?.toLocaleString() || total.toLocaleString()}</span></h1>
        <div className="sub"><span className="mono" style={{ color: 'var(--fg-4)' }}>{table}</span> · page {page + 1} of {lastPage + 1}</div>
        <div className="toolbar"><div className="spacer" /><Pager page={page} setPage={setPage} lastPage={lastPage} /></div>
      </div>
      <table className="dt">
        <thead><tr>
          <th>Name</th><th style={{ width: 120 }}>Type</th><th>Target table</th><th>Event</th><th style={{ width: 90 }}>Active</th>
        </tr></thead>
        <tbody>
          {loading && resp.rows == null && (
            <tr><td colSpan={5} style={{ padding: 60, color: 'var(--fg-4)', textAlign: 'center' }}>
              <span className="dot-pulse" style={{ display: 'inline-block', marginRight: 8 }} />loading…
            </td></tr>
          )}
          {!loading && resp.rows && resp.rows.length === 0 && (
            <tr><td colSpan={5} style={{ padding: 40, color: 'var(--fg-4)', textAlign: 'center' }}>None in this snapshot.</td></tr>
          )}
          {(resp.rows || []).map(a => (
            <tr key={a.sys_id} onClick={() => window.navigate(window.recordUrl(table, a.sys_id))}>
              <td><strong style={{ fontWeight: 500 }}>{a.name}</strong></td>
              <td className="muted">{a.type || '—'}</td>
              <td className="mono" style={{ fontSize: 12 }}>{a[targetField] || '—'}</td>
              <td className="muted mono" style={{ fontSize: 11.5 }}>{a.event_name || '—'}</td>
              <td>{isOn(a.active) ? <span className="chip" style={{ fontSize: 10.5 }}>active</span> : <span className="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- CIs (paginated via API since cmdb_ci has 1M+ records) ---------------

function CIList() {
  const data = window.HistoricalWowData;
  const [q, setQ] = React.useState('');
  const [debouncedQ, setDebouncedQ] = React.useState('');
  const [page, setPage] = React.useState(0);
  const [resp, setResp] = React.useState({ rows: null, total: 0 });
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  React.useEffect(() => { setPage(0); }, [debouncedQ]);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    data.fetchTaskList('cmdb_ci', {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      q: debouncedQ,
      order_by: 'name', dir: 'asc',
    }).then(r => {
      if (cancelled) return;
      setResp(r); setLoading(false);
    }).catch(() => {
      if (cancelled) return;
      setResp({ rows: [], total: 0 }); setLoading(false);
    });
    return () => { cancelled = true; };
  }, [debouncedQ, page]);

  const total = resp.total || 0;
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  return (
    <div>
      <div className="page-header">
        <h1>Configuration items <span className="count mono">{data.manifest.tables.find(t => t.table === 'cmdb_ci')?.source_rows?.toLocaleString() || '—'}</span></h1>
        <div className="sub"><span className="mono" style={{ color: 'var(--fg-4)' }}>cmdb_ci</span> · {total.toLocaleString()} matching · page {page + 1} of {lastPage + 1}</div>
        <div className="toolbar">
          <div className="spacer" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter by name…"
            style={{ height: 26, padding: '0 10px', border: '1px solid var(--border-2)', borderRadius: 14, background: 'var(--bg-elev)', fontSize: 12, outline: 'none', width: 240 }} />
          <Pager page={page} setPage={setPage} lastPage={lastPage} />
        </div>
      </div>
      <table className="dt">
        <thead><tr>
          <th>Name</th><th>Class</th><th style={{ width: 130 }}>Status</th><th>Owned by</th>
        </tr></thead>
        <tbody>
          {loading && (resp.rows == null) && (
            <tr><td colSpan={4} style={{ padding: 60, color: 'var(--fg-4)', textAlign: 'center' }}>
              <span className="dot-pulse" style={{ display: 'inline-block', marginRight: 8 }} />loading…
            </td></tr>
          )}
          {!loading && resp.rows && resp.rows.length === 0 && (
            <tr><td colSpan={4} style={{ padding: 40, color: 'var(--fg-4)', textAlign: 'center' }}>No matching CIs.</td></tr>
          )}
          {(resp.rows || []).map(c => {
            const stCls = c.operational_status === 'Operational' ? 'green'
                         : c.operational_status === 'Degraded' ? 'amber'
                         : c.operational_status === 'Down' ? 'red' : '';
            return (
              <tr key={c.sys_id} onClick={() => window.navigate(`/cis/${c.sys_id}`)}>
                <td className="num">{c.name}</td>
                <td className="muted mono" style={{ fontSize: 12 }}>{c.sys_class_name}</td>
                <td>{c.operational_status ? <span className={`chip ${stCls}`}><span className="swatch" />{c.operational_status}</span> : <span className="muted">—</span>}</td>
                <td className="muted">{window.findGroup(c.owned_by)?.name || '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

Object.assign(window, { ListPage });
