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
  incident_task:     { plural: 'Incident tasks',    singular: 'Incident task' },
  change_task:       { plural: 'Change tasks',      singular: 'Change task' },
};
window.taskLabel = function (table, mode = 'plural') {
  const e = window.TASK_LABELS[table];
  if (e) return e[mode];
  const text = table.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

const PAGE_SIZE = 50;

const ListPage = window.ListPage = function ListPage({ table }) {
  if (table === 'sys_user')        return <UserList />;
  if (table === 'sys_user_group')  return <GroupList />;
  if (table === 'cmdb_ci')         return <CIList />;
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

// ---- Users ---------------------------------------------------------------

function UserList() {
  const data = window.HistoricalWowData;
  const [q, setQ] = React.useState('');
  let rows = data.sys_user.slice();
  if (q.trim()) {
    const ql = q.toLowerCase();
    rows = rows.filter(r =>
      (r.name || '').toLowerCase().includes(ql) ||
      (r.user_name || '').toLowerCase().includes(ql) ||
      (r.title || '').toLowerCase().includes(ql)
    );
  }
  rows.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const display = rows.slice(0, 500);  // cap render for perf

  return (
    <div>
      <div className="page-header">
        <h1>Users <span className="count mono">{data.manifest.tables.find(t => t.table === 'sys_user')?.source_rows?.toLocaleString() || '—'}</span></h1>
        <div className="sub"><span className="mono" style={{ color: 'var(--fg-4)' }}>sys_user</span> · {rows.length.toLocaleString()} of {data.sys_user.length.toLocaleString()} loaded</div>
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
