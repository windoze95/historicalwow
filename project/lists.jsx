/* eslint-disable */
// List views for incidents, changes, users, groups, CIs, and any task table

// Friendly labels for sidebar / breadcrumbs / page titles, keyed by table.
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
  // Fall back: humanize the SN table name for less-common task tables
  const text = table.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

const ListPage = window.ListPage = function ListPage({ table }) {
  const [filter, setFilter] = React.useState('all');
  const [q, setQ] = React.useState('');
  const data = window.HistoricalWowData;

  if (table === 'incident') return <IncidentList filter={filter} setFilter={setFilter} q={q} setQ={setQ} />;
  if (table === 'change_request') return <ChangeList filter={filter} setFilter={setFilter} q={q} setQ={setQ} />;
  if (table === 'sys_user') return <UserList q={q} setQ={setQ} />;
  if (table === 'sys_user_group') return <GroupList />;
  if (table === 'cmdb_ci') return <CIList q={q} setQ={setQ} />;
  // Any task descendant we don't have a specialized list for falls through
  // to the generic task list, which adapts to the table's available fields.
  if (window.TASK_TABLES && window.TASK_TABLES.includes(table)) {
    return <TaskList table={table} filter={filter} setFilter={setFilter} q={q} setQ={setQ} />;
  }
  return null;
};

function TaskList({ table, filter, setFilter, q, setQ }) {
  const data = window.HistoricalWowData;
  const rows0 = window.getTaskRecords(table);
  const label = window.taskLabel(table, 'plural');

  const filters = [
    { id: 'all',    label: 'All' },
    { id: 'open',   label: 'Open' },
    { id: 'closed', label: 'Closed' },
  ];
  let rows = rows0.slice();
  if (filter === 'open')   rows = rows.filter(r => !['3','4','6','7','8'].includes(String(r.state)));
  if (filter === 'closed') rows = rows.filter(r => ['3','4','7'].includes(String(r.state)));
  if (q.trim()) {
    const ql = q.toLowerCase();
    rows = rows.filter(r =>
      (r.number || '').toLowerCase().includes(ql) ||
      (r.short_description || '').toLowerCase().includes(ql)
    );
  }
  rows.sort((a, b) => (b.sys_updated_on || '').localeCompare(a.sys_updated_on || ''));

  const manifestEntry = data.manifest.tables.find(t => t.table === table);
  const sourceCount = manifestEntry ? manifestEntry.source_rows.toLocaleString() : rows0.length.toLocaleString();

  return (
    <div>
      <div className="page-header">
        <h1>{label} <span className="count mono">{sourceCount}</span></h1>
        <div className="sub">
          <span className="mono" style={{ color: 'var(--fg-4)' }}>{table}</span> ·
          {' '}showing {rows.length} of {rows0.length} loaded rows
        </div>
        <div className="toolbar">
          {filters.map(f => (
            <button key={f.id} className={'filter-pill' + (filter === f.id ? ' active' : '')} onClick={() => setFilter(f.id)}>{f.label}</button>
          ))}
          <div className="spacer" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter visible…"
            style={{ height: 26, padding: '0 10px', border: '1px solid var(--border-2)', borderRadius: 14, background: 'var(--bg-elev)', fontSize: 12, outline: 'none', width: 220 }} />
          <span className="results">{rows.length} rows</span>
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
          {rows.length === 0 && (
            <tr><td colSpan={7} style={{ padding: '40px 20px', color: 'var(--fg-4)', textAlign: 'center' }}>
              No rows loaded for this table.
            </td></tr>
          )}
          {rows.map(r => {
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
                <td>{r.assigned_to ? <window.UserCell sys_id={r.assigned_to} /> : <span className="muted">—</span>}</td>
                <td className="muted">{window.findGroup(r.assignment_group)?.name || '—'}</td>
                <td className="num muted" title={r.sys_updated_on}>{window.fmtRelative(r.sys_updated_on)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function IncidentList({ filter, setFilter, q, setQ }) {
  const data = window.HistoricalWowData;
  const filters = [
    { id: 'all',     label: 'All' },
    { id: 'open',    label: 'Open' },
    { id: 'p1',      label: 'P1 / P2' },
    { id: 'closed',  label: 'Closed' },
    { id: 'hold',    label: 'Legal hold' },
  ];
  let rows = data.incidents.slice();
  if (filter === 'open')   rows = rows.filter(r => !['6','7','8'].includes(r.state));
  if (filter === 'closed') rows = rows.filter(r => ['7'].includes(r.state));
  if (filter === 'p1')     rows = rows.filter(r => ['1','2'].includes(r.priority));
  if (filter === 'hold')   rows = rows.filter(r => r.legal_hold);
  if (q.trim()) {
    const ql = q.toLowerCase();
    rows = rows.filter(r => r.number.toLowerCase().includes(ql) || r.short_description.toLowerCase().includes(ql));
  }
  rows.sort((a, b) => b.sys_updated_on.localeCompare(a.sys_updated_on));

  return (
    <div>
      <div className="page-header">
        <h1>
          Incidents
          <span className="count mono">{data.manifest.tables.find(t => t.table === 'incident').source_rows.toLocaleString()}</span>
        </h1>
        <div className="sub">
          <span className="mono" style={{ color: 'var(--fg-4)' }}>incident</span> ·
          {' '}showing {rows.length.toLocaleString()} of {data.incidents.length.toLocaleString()} rows in this snapshot
          {' '}<span style={{ color: 'var(--fg-4)' }}>(remaining {(data.manifest.tables.find(t=>t.table==='incident').source_rows - data.incidents.length).toLocaleString()} archived but not loaded)</span>
        </div>
        <div className="toolbar">
          {filters.map(f => (
            <button key={f.id}
              className={'filter-pill' + (filter === f.id ? ' active' : '')}
              onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
          <div className="spacer" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Filter visible…"
            style={{
              height: 26, padding: '0 10px',
              border: '1px solid var(--border-2)', borderRadius: 14,
              background: 'var(--bg-elev)', fontSize: 12, outline: 'none', width: 220,
            }}
          />
          <span className="results">{rows.length} rows</span>
        </div>
      </div>
      <table className="dt">
        <thead>
          <tr>
            <th style={{ width: 110 }}>Number</th>
            <th>Short description</th>
            <th style={{ width: 110 }}>Priority</th>
            <th style={{ width: 130 }}>State</th>
            <th style={{ width: 180 }}>Caller</th>
            <th style={{ width: 180 }}>Assigned to</th>
            <th style={{ width: 170 }}>Group</th>
            <th style={{ width: 130 }} className="num">Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const caller = window.findUser(r.caller_id);
            const assignee = window.findUser(r.assigned_to);
            const group = window.findGroup(r.assignment_group);
            const prDec = window.decodeChoice('incident', 'priority', r.priority);
            const stDec = window.decodeChoice('incident', 'state', r.state);
            const bars = window.priorityBars(r.priority);
            return (
              <tr key={r.sys_id} onClick={() => window.navigate(`/incidents/${r.sys_id}`)}>
                <td className="num">{r.number}</td>
                <td className="short"><span className="truncate">{r.short_description}{r.legal_hold && <span style={{ marginLeft: 8, color: 'var(--c-amber)' }} title="Legal hold"><window.Icon name="lock" size={11} /></span>}</span></td>
                <td>
                  <span className={`chip ${window.priorityChipClass(r.priority)}`} title={prDec.label}>
                    <span className={`priority-bar ${bars.cls}`}>
                      {[0,1,2,3,4].map(i => <span key={i} className={'b' + (i < bars.filled ? ' on' : '')} style={{ height: 4 + i * 2 }} />)}
                    </span>
                    {prDec.label.split(' — ')[0]}
                  </span>
                </td>
                <td><span className={`chip ${window.stateChipClass('incident', r.state)}`}>{stDec.label}</span></td>
                <td>{caller ? <window.UserCell sys_id={r.caller_id} /> : <span className="muted">—</span>}</td>
                <td>{assignee ? <window.UserCell sys_id={r.assigned_to} /> : <span className="muted">—</span>}</td>
                <td className="muted">{group?.name || '—'}</td>
                <td className="num muted" title={r.sys_updated_on}>{window.fmtRelative(r.sys_updated_on)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ChangeList({ filter, setFilter, q, setQ }) {
  const data = window.HistoricalWowData;
  const filters = [
    { id: 'all',  label: 'All' },
    { id: 'open', label: 'In flight' },
    { id: 'closed', label: 'Closed' },
    { id: 'emerg', label: 'Emergency' },
  ];
  let rows = data.changes.slice();
  if (filter === 'open')   rows = rows.filter(r => !['3','4'].includes(r.state));
  if (filter === 'closed') rows = rows.filter(r => r.state === '3');
  if (filter === 'emerg')  rows = rows.filter(r => r.type === 'emergency');
  if (q.trim()) {
    const ql = q.toLowerCase();
    rows = rows.filter(r => r.number.toLowerCase().includes(ql) || r.short_description.toLowerCase().includes(ql));
  }
  rows.sort((a, b) => b.sys_updated_on.localeCompare(a.sys_updated_on));

  return (
    <div>
      <div className="page-header">
        <h1>
          Change requests
          <span className="count mono">{data.manifest.tables.find(t => t.table === 'change_request').source_rows.toLocaleString()}</span>
        </h1>
        <div className="sub">
          <span className="mono" style={{ color: 'var(--fg-4)' }}>change_request</span> ·
          {' '}showing {rows.length} of {data.changes.length} loaded rows
        </div>
        <div className="toolbar">
          {filters.map(f => (
            <button key={f.id} className={'filter-pill' + (filter === f.id ? ' active' : '')} onClick={() => setFilter(f.id)}>{f.label}</button>
          ))}
          <div className="spacer" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter visible…"
            style={{ height: 26, padding: '0 10px', border: '1px solid var(--border-2)', borderRadius: 14, background: 'var(--bg-elev)', fontSize: 12, outline: 'none', width: 220 }} />
          <span className="results">{rows.length} rows</span>
        </div>
      </div>
      <table className="dt">
        <thead>
          <tr>
            <th style={{ width: 130 }}>Number</th>
            <th>Short description</th>
            <th style={{ width: 110 }}>Type</th>
            <th style={{ width: 100 }}>Risk</th>
            <th style={{ width: 130 }}>State</th>
            <th style={{ width: 180 }}>Assigned to</th>
            <th style={{ width: 170 }}>Group</th>
            <th style={{ width: 130 }} className="num">Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const stDec = window.decodeChoice('change_request', 'state', r.state);
            const tCls = r.type === 'emergency' ? 'red' : r.type === 'normal' ? 'amber' : 'green';
            const rCls = r.risk === 'high' ? 'red' : r.risk === 'medium' ? 'amber' : 'green';
            return (
              <tr key={r.sys_id} onClick={() => window.navigate(`/changes/${r.sys_id}`)}>
                <td className="num">{r.number}</td>
                <td className="short"><span className="truncate">{r.short_description}</span></td>
                <td><span className={`chip ${tCls}`}>{r.type}</span></td>
                <td><span className={`chip ${rCls}`}>{r.risk}</span></td>
                <td><span className={`chip ${window.stateChipClass('change_request', r.state)}`}>{stDec.label}</span></td>
                <td>{r.assigned_to ? <window.UserCell sys_id={r.assigned_to} /> : <span className="muted">—</span>}</td>
                <td className="muted">{window.findGroup(r.assignment_group)?.name || '—'}</td>
                <td className="num muted" title={r.sys_updated_on}>{window.fmtRelative(r.sys_updated_on)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function UserList({ q, setQ }) {
  const data = window.HistoricalWowData;
  let rows = data.sys_user.slice();
  if (q.trim()) {
    const ql = q.toLowerCase();
    rows = rows.filter(r => r.name.toLowerCase().includes(ql) || r.user_name.toLowerCase().includes(ql) || (r.title || '').toLowerCase().includes(ql));
  }
  rows.sort((a,b) => a.name.localeCompare(b.name));
  return (
    <div>
      <div className="page-header">
        <h1>Users <span className="count mono">{data.manifest.tables.find(t => t.table === 'sys_user').source_rows.toLocaleString()}</span></h1>
        <div className="sub"><span className="mono" style={{ color: 'var(--fg-4)' }}>sys_user</span> · {rows.length} of {data.sys_user.length} loaded</div>
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
          {rows.map(u => (
            <tr key={u.sys_id} onClick={() => window.navigate(`/users/${u.sys_id}`)}>
              <td><window.UserCell sys_id={u.sys_id} asLink={false} /></td>
              <td className="num">{u.user_name}</td>
              <td>{u.title}</td>
              <td className="muted">{window.findDepartment(u.department)?.name || '—'}</td>
              <td className="muted">{window.findLocation(u.location)?.name || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GroupList() {
  const data = window.HistoricalWowData;
  const rows = data.sys_user_group.slice().sort((a,b) => a.name.localeCompare(b.name));
  return (
    <div>
      <div className="page-header">
        <h1>Groups <span className="count mono">{data.manifest.tables.find(t => t.table === 'sys_user_group').source_rows.toLocaleString()}</span></h1>
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
              <td>{g.manager ? <window.UserCell sys_id={g.manager} /> : <span className="muted">—</span>}</td>
              <td className="num">{g.member_sys_ids.length}</td>
              <td className="muted">{g.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CIList({ q, setQ }) {
  const data = window.HistoricalWowData;
  let rows = data.cmdb_ci.slice();
  if (q.trim()) {
    const ql = q.toLowerCase();
    rows = rows.filter(r => r.name.toLowerCase().includes(ql) || r.sys_class_name.toLowerCase().includes(ql));
  }
  rows.sort((a,b) => a.name.localeCompare(b.name));
  return (
    <div>
      <div className="page-header">
        <h1>Configuration items <span className="count mono">{data.manifest.tables.find(t => t.table === 'cmdb_ci').source_rows.toLocaleString()}</span></h1>
        <div className="sub"><span className="mono" style={{ color: 'var(--fg-4)' }}>cmdb_ci</span> · {rows.length} of {data.cmdb_ci.length} loaded</div>
        <div className="toolbar">
          <div className="spacer" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter…"
            style={{ height: 26, padding: '0 10px', border: '1px solid var(--border-2)', borderRadius: 14, background: 'var(--bg-elev)', fontSize: 12, outline: 'none', width: 240 }} />
        </div>
      </div>
      <table className="dt">
        <thead><tr>
          <th>Name</th><th>Class</th><th style={{ width: 130 }}>Status</th><th>Owned by</th><th>Description</th>
        </tr></thead>
        <tbody>
          {rows.map(c => {
            const stCls = c.operational_status === 'Operational' ? 'green' : c.operational_status === 'Degraded' ? 'amber' : c.operational_status === 'Down' ? 'red' : '';
            return (
              <tr key={c.sys_id} onClick={() => window.navigate(`/cis/${c.sys_id}`)}>
                <td className="num">{c.name}</td>
                <td className="muted mono" style={{ fontSize: 12 }}>{c.sys_class_name}</td>
                <td><span className={`chip ${stCls}`}><span className="swatch" />{c.operational_status}</span></td>
                <td className="muted">{window.findGroup(c.owned_by)?.name || '—'}</td>
                <td className="muted short"><span className="truncate">{c.short_description}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

Object.assign(window, { ListPage });
