/* eslint-disable */
// Reference pages: user, group, ci, home dashboard

window.HomePage = function HomePage({ openPalette }) {
  const data = window.HistoricalWowData;
  const [recent, setRecent] = React.useState(null);  // null = loading
  const [openP1, setOpenP1] = React.useState(null);

  React.useEffect(() => {
    let cancel = false;
    // Recent — most recently updated incidents (the dominant table; fetching
    // top-N across every task table would mean N parallel API calls).
    data.fetchTaskList('incident', { limit: 8, order_by: 'sys_updated_on', dir: 'desc' })
      .then(r => { if (!cancel) setRecent((r.rows || []).map(x => ({ rec: x, table: 'incident' }))); })
      .catch(() => { if (!cancel) setRecent([]); });
    // "Open P1 / P2 at snapshot time" — historical lens: which high-priority
    // incidents were still open the moment we exported. The /api endpoint
    // doesn't support OR or NOT-IN, so we fan out two queries (P1 and P2)
    // with a generous limit and filter client-side. Sorting by opened_at
    // DESC biases toward newer tickets that are more likely to still be
    // open, so 200-row pages comfortably catch any open ones.
    Promise.all([
      data.fetchTaskList('incident', { limit: 200, filters: { priority: '1' }, order_by: 'opened_at', dir: 'desc' }).catch(() => ({ rows: [] })),
      data.fetchTaskList('incident', { limit: 200, filters: { priority: '2' }, order_by: 'opened_at', dir: 'desc' }).catch(() => ({ rows: [] })),
    ]).then(([p1, p2]) => {
      if (cancel) return;
      const isClosed = s => ['6', '7', '8'].includes(String(s));
      const merged = [...(p1.rows || []), ...(p2.rows || [])]
        .filter(i => !isClosed(i.state))
        .sort((a, b) => String(a.priority).localeCompare(String(b.priority))
                      || (b.opened_at || '').localeCompare(a.opened_at || ''))
        .slice(0, 6);
      setOpenP1(merged);
    });
    return () => { cancel = true; };
  }, []);
  return (
    <div style={{ padding: '32px 32px 60px', maxWidth: 1080, margin: '0 auto' }}>
      <div style={{ marginBottom: 30 }}>
        <div style={{ fontSize: 12, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '.08em', fontWeight: 600 }}>
          ServiceNow Historical Archive
        </div>
        <h1 style={{ margin: '6px 0 8px', fontSize: 26, fontWeight: 600, letterSpacing: '-0.02em' }}>
          Snapshot · {data.manifest.snapshot_date || '—'} {data.manifest.label || ''}
        </h1>
        <div style={{ color: 'var(--fg-3)', fontSize: 13.5, maxWidth: 720, lineHeight: 1.6 }}>
          Read-only archive of <span className="mono" style={{ fontSize: 12.5 }}>northwind.service-now.com</span>.
          Incidents, change requests, and all referenced context (users, groups, CIs, choices) — captured for the
          archival exit. No writes. No backfill.
        </div>
      </div>

      <div onClick={openPalette} style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '12px 16px',
        background: 'var(--bg-elev)', border: '1px solid var(--border-2)',
        borderRadius: 10, cursor: 'text', marginBottom: 24,
        boxShadow: 'var(--shadow-sm)',
      }}>
        <window.Icon name="search" size={16} />
        <span style={{ color: 'var(--fg-3)', flex: 1 }}>Search incidents, changes, users, groups, CIs, journal…</span>
        <span className="kbd-inline">⌘ K</span>
      </div>

      {(() => {
        // Featured tiles. Order matters — these render left-to-right /
        // top-to-bottom. The `slice(0, 8)` of the alphabetically-sorted
        // manifest was producing useless tiles like asset_task=0 and
        // cmn_cost_center=411 while the headline tables (incident,
        // sys_user, alm_hardware) never made the cut.
        const FEATURED = [
          { table: 'incident',       label: 'Incidents',         url: '/incidents' },
          { table: 'change_request', label: 'Change requests',   url: '/changes' },
          { table: 'problem',        label: 'Problems',          url: '/problems' },
          { table: 'sc_req_item',    label: 'Requested items',   url: '/requested-items' },
          { table: 'cmdb_ci',        label: 'Configuration items', url: '/cis' },
          { table: 'sys_user',       label: 'Users',             url: '/users' },
          { table: 'alm_hardware',   label: 'Hardware',          url: '/hardware' },
          { table: 'cmdb_software_instance', label: 'Software installs', url: '/software-installs' },
        ];
        const tilesByTable = Object.fromEntries((data.manifest.tables || []).map(t => [t.table, t]));
        const tiles = FEATURED
          .map(f => ({ ...f, info: tilesByTable[f.table] }))
          .filter(f => f.info && (f.info.source_rows || 0) > 0);
        return (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 28 }}>
            {tiles.map(f => (
              <div key={f.table} style={{
                background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8,
                padding: '12px 14px', cursor: 'pointer',
              }} onClick={() => window.navigate(f.url)}>
                <div style={{ fontSize: 11.5, color: 'var(--fg-3)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span>{f.label}</span>
                  <span className="mono" style={{ color: 'var(--fg-4)', fontSize: 10.5 }}>· {f.table}</span>
                </div>
                <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-.02em', marginTop: 4, fontFamily: 'var(--font-mono)' }}>
                  {f.info.source_rows.toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        );
      })()}

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 22 }}>
        <div>
          <h2 style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--fg-3)', margin: '0 0 10px' }}>
            Recently updated
          </h2>
          <table className="dt" style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            <tbody>
              {recent == null && (
                <tr><td colSpan={4} style={{ padding: '24px 12px', color: 'var(--fg-4)', textAlign: 'center' }}>
                  <span className="dot-pulse" style={{ display: 'inline-block', marginRight: 8 }} />loading…
                </td></tr>
              )}
              {recent && recent.length === 0 && (
                <tr><td colSpan={4} style={{ padding: '24px 12px', color: 'var(--fg-4)', textAlign: 'center' }}>No recent incidents.</td></tr>
              )}
              {(recent || []).map(({ rec: i, table: t }) => (
                <tr key={i.sys_id} onClick={() => window.navigate(window.recordUrl(t, i.sys_id))}>
                  <td className="num" style={{ width: 110 }}>{i.number}</td>
                  <td className="short"><span className="truncate">{i.short_description}</span></td>
                  <td style={{ width: 96 }}>
                    <span className="chip" style={{ fontSize: 10.5 }}>{window.taskLabel(t, 'singular')}</span>
                  </td>
                  <td style={{ width: 110 }}>{i.state ? <span className={`chip ${window.stateChipClass('incident', i.state)}`}>{window.decodeChoice('incident', 'state', i.state).label || i.state}</span> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <h2 style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--fg-3)', margin: '0 0 10px' }}>
            Snapshot integrity
          </h2>
          <div style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, padding: 16, fontSize: 12.5 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--accent)' }} />
              <span style={{ fontWeight: 500 }}>Snapshot verified</span>
              <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-4)' }}>{data.manifest.captured_at}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', rowGap: 6, fontSize: 12 }}>
              <span style={{ color: 'var(--fg-3)' }}>Tables exported</span>
              <span className="mono">{data.manifest.tables.length}</span>
              <span style={{ color: 'var(--fg-3)' }}>Source rows</span>
              <span className="mono">{data.manifest.tables.reduce((a, t) => a + (t.source_rows || 0), 0).toLocaleString()}</span>
              {data.manifest.integrity.acl_skips > 0 && (
                <>
                  <span style={{ color: 'var(--fg-3)' }}>ACL skips</span>
                  <span className="mono">{data.manifest.integrity.acl_skips.toLocaleString()}</span>
                </>
              )}
              {data.manifest.integrity.missing_attachments > 0 && (
                <>
                  <span style={{ color: 'var(--fg-3)' }}>Missing attachments</span>
                  <span className="mono">{data.manifest.integrity.missing_attachments.toLocaleString()}</span>
                </>
              )}
              {data.manifest.integrity.sha256_manifest && (
                <>
                  <span style={{ color: 'var(--fg-3)' }}>SHA-256 manifest</span>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--fg-4)' }}>{data.manifest.integrity.sha256_manifest.slice(0, 16)}…</span>
                </>
              )}
            </div>
          </div>
          <h2 style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--fg-3)', margin: '20px 0 10px' }}>
            Open P1 / P2
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {openP1 == null && (
              <div style={{ padding: '12px', color: 'var(--fg-4)', fontSize: 12 }}>
                <span className="dot-pulse" style={{ display: 'inline-block', marginRight: 8 }} />loading…
              </div>
            )}
            {openP1 && openP1.length === 0 && (
              <div style={{ padding: '12px', color: 'var(--fg-4)', fontSize: 12 }}>None.</div>
            )}
            {(openP1 || []).map(i => (
              <div key={i.sys_id} onClick={() => window.navigate(`/incidents/${i.sys_id}`)}
                   style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <span className={`chip ${window.priorityChipClass(i.priority)}`}>P{i.priority}</span>
                <span className="mono" style={{ fontSize: 12 }}>{i.number}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5 }}>{i.short_description}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

// Per-user relationship × table fan-out for the user record page.
// `tables` is the scoped allow-list for each relationship — `requested_for`
// is only meaningful on catalog tables, so it's not queried on `incident`
// or `sn_contract_renewal_task`.
const USER_RELATIONS = [
  { field: 'caller_id',     label: 'as caller',        tables: ['incident', 'sc_request', 'sc_req_item', 'sc_task', 'sn_contract_renewal_task'] },
  { field: 'requested_for', label: 'as requested for', tables: ['sc_request', 'sc_req_item', 'sc_task'] },
  { field: 'assigned_to',   label: 'as assignee',      tables: ['incident', 'sc_request', 'sc_req_item', 'sc_task', 'sn_contract_renewal_task'] },
];
// Stable display order for the per-table sections — top-down task volume,
// then the catalog flow REQ → RITM → SCTASK, then asset-task siblings.
const USER_TABLE_ORDER = ['incident', 'sc_request', 'sc_req_item', 'sc_task', 'sn_contract_renewal_task'];

window.UserRefPage = function UserRefPage({ sys_id }) {
  const data = window.HistoricalWowData;
  const u = window.findUser(sys_id);
  // relations: null while loading; otherwise { [field]: [{table, items, total}, ...] }
  const [relations, setRelations]   = React.useState(null);
  const [hwAssigned, setHwAssigned] = React.useState(null);
  const [hwOwned, setHwOwned]       = React.useState(null);

  React.useEffect(() => {
    if (u) window.AuditLog.push('view', `sys_user/${u.user_name}`, u.name);
    let cancel = false;
    setRelations(null);
    setHwAssigned(null); setHwOwned(null);
    // Fan out across (relation × table) in parallel. Each promise resolves to
    // [field, buckets[]]; collect into a {field: buckets[]} map.
    Promise.all(USER_RELATIONS.map(({ field, tables }) =>
      bucketTaskRecordsAsync(field, sys_id, { tables })
        .then(buckets => [field, buckets])
        .catch(() => [field, []])
    )).then(pairs => {
      if (cancel) return;
      setRelations(Object.fromEntries(pairs));
    });
    // Hardware this user is assigned / owns
    data.fetchTaskList('alm_hardware', { limit: 24, filters: { assigned_to: sys_id }, order_by: 'sys_updated_on', dir: 'desc' })
      .then(r => { if (!cancel) setHwAssigned(r); }).catch(() => { if (!cancel) setHwAssigned({ rows: [], total: 0 }); });
    data.fetchTaskList('alm_hardware', { limit: 24, filters: { owned_by: sys_id }, order_by: 'sys_updated_on', dir: 'desc' })
      .then(r => { if (!cancel) setHwOwned(r); }).catch(() => { if (!cancel) setHwOwned({ rows: [], total: 0 }); });
    return () => { cancel = true; };
  }, [sys_id]);

  if (!u) return <div className="empty"><div className="glyph"><window.Icon name="info" /></div>User not in snapshot.</div>;

  const groupMembership = data.sys_user_group.filter(g => (g.member_sys_ids || []).includes(sys_id));

  return (
    <div className="ref-page">
      <div className="crumbs" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--fg-3)', marginBottom: 14 }}>
        <a onClick={() => window.navigate('/users')}>Users</a>
        <window.Icon name="chevron_right" size={11} />
        <span className="mono">{u.user_name}</span>
      </div>
      <div className="head">
        <window.Avatar name={u.name} size="xl" />
        <div className="info">
          <h1>{u.name}</h1>
          <div className="meta">
            <span>{u.title}</span>
            <span style={{ color: 'var(--fg-4)' }}>·</span>
            <span className="mono">{u.user_name}</span>
            <span style={{ color: 'var(--fg-4)' }}>·</span>
            <span>{u.email}</span>
          </div>
        </div>
      </div>

      <div className="ref-grid">
        <div className="cell"><div className="label">Department</div><div className="val">{window.findDepartment(u.department)?.name || '—'}</div></div>
        <div className="cell"><div className="label">Location</div><div className="val">{window.findLocation(u.location)?.name || '—'}</div></div>
        <div className="cell"><div className="label">Company</div><div className="val">{window.findCompany(u.company)?.name || '—'}</div></div>
        {(() => {
          const cc = window.findCostCenter(u.cost_center) ||
                     window.findCostCenter(window.findDepartment(u.department)?.cost_center);
          return (
            <div className="cell">
              <div className="label">Cost center</div>
              <div className="val">{cc ? `${cc.name}${cc.code ? ` · ${cc.code}` : ''}` : '—'}</div>
            </div>
          );
        })()}
        <div className="cell"><div className="label">Active</div><div className="val">{u.active ? 'true' : 'false'}</div></div>
        <div className="cell"><div className="label">sys_id</div><div className="val mono" style={{ fontSize: 12, color: 'var(--fg-3)' }}>{u.sys_id}</div></div>
        <div className="cell"><div className="label">Last updated</div><div className="val">{u.sys_updated_on}</div></div>
      </div>

      <div className="ref-section">
        <h2>Group membership <span className="count">{groupMembership.length}</span></h2>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {groupMembership.map(g => (
            <span key={g.sys_id} className="chip" style={{ cursor: 'pointer' }} onClick={() => window.navigate(`/groups/${g.sys_id}`)}>
              <window.Icon name="users" size={11} />{g.name}
            </span>
          ))}
          {groupMembership.length === 0 && <span style={{ color: 'var(--fg-4)', fontSize: 12.5 }}>None.</span>}
        </div>
      </div>

      {relations == null && (
        <div className="ref-section">
          <h2>Related work <span className="count">…</span></h2>
          <div style={{ color: 'var(--fg-4)', fontSize: 12.5 }}>
            <span className="dot-pulse" style={{ display: 'inline-block', marginRight: 8 }} />loading…
          </div>
        </div>
      )}
      {relations != null && (() => {
        // Pivot relations ({field: buckets[]}) into per-table view:
        //   byTable[t] = [{ label, total, items }, ...]   (one entry per non-empty relationship)
        const byTable = {};
        for (const { field, label } of USER_RELATIONS) {
          for (const bucket of (relations[field] || [])) {
            if (!byTable[bucket.table]) byTable[bucket.table] = [];
            byTable[bucket.table].push({ label, total: bucket.total, items: bucket.items });
          }
        }
        const tables = USER_TABLE_ORDER.filter(t => byTable[t]);
        if (tables.length === 0) {
          return (
            <div className="ref-section">
              <h2>Related work <span className="count">0</span></h2>
              <div style={{ color: 'var(--fg-4)', fontSize: 12.5 }}>None in this snapshot.</div>
            </div>
          );
        }
        return tables.map(t => (
          <div key={t} className="ref-section">
            <h2>{window.taskLabel(t, 'plural')}</h2>
            {byTable[t].map(({ label, total, items }) => (
              <div key={label} style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12.5, color: 'var(--fg-3)', marginBottom: 6, fontWeight: 500 }}>
                  · {label} <span className="count">{total.toLocaleString()}</span>
                </div>
                <SmallIncTable incidents={items} table={t} />
              </div>
            ))}
          </div>
        ));
      })()}
      {hwAssigned && hwAssigned.total > 0 && (
        <div className="ref-section">
          <h2>Hardware · assigned <span className="count">{hwAssigned.total.toLocaleString()}</span></h2>
          <HardwareGrid rows={hwAssigned.rows} />
        </div>
      )}
      {hwOwned && hwOwned.total > 0 && (
        <div className="ref-section">
          <h2>Hardware · owned <span className="count">{hwOwned.total.toLocaleString()}</span></h2>
          <HardwareGrid rows={hwOwned.rows} />
        </div>
      )}
    </div>
  );
};

function HardwareGrid({ rows }) {
  if (!rows || rows.length === 0) {
    return <div style={{ color: 'var(--fg-4)', fontSize: 12.5 }}>None.</div>;
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
      {rows.map(h => (
        <div key={h.sys_id}
             onClick={() => window.navigate(`/hardware/${h.sys_id}`)}
             style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', cursor: 'pointer' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <window.Icon name="ci" size={12} />
            <span className="mono" style={{ fontSize: 12 }}>{h.asset_tag || h.sys_id.slice(0, 8) + '…'}</span>
            <span className="chip" style={{ marginLeft: 'auto', fontSize: 10.5 }}>
              {h.__display_install_status || h.install_status || h.state || '—'}
            </span>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--fg-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {h.display_name || h.name || '—'}
          </div>
          {h.serial_number && (
            <div className="mono" style={{ fontSize: 11, color: 'var(--fg-4)', marginTop: 2 }}>SN {h.serial_number}</div>
          )}
        </div>
      ))}
    </div>
  );
}

// Compact tabular list of task records. Defaults to incident routing for
// backward compatibility — pass `table={...}` to navigate to other task types.
function SmallIncTable({ incidents, table = 'incident' }) {
  if (incidents == null) {
    return <div style={{ color: 'var(--fg-4)', fontSize: 12.5 }}>
      <span className="dot-pulse" style={{ display: 'inline-block', marginRight: 8 }} />loading…
    </div>;
  }
  if (!incidents.length) return <div style={{ color: 'var(--fg-4)', fontSize: 12.5 }}>None in this snapshot.</div>;
  return (
    <table className="dt" style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
      <tbody>
        {incidents.slice(0, 12).map(i => (
          <tr key={i.sys_id} onClick={() => window.navigate(window.recordUrl(table, i.sys_id))}>
            <td className="num" style={{ width: 110 }}>{i.number}</td>
            <td className="short"><span className="truncate">{i.short_description}</span></td>
            <td style={{ width: 80 }}>{i.priority ? <span className={`chip ${window.priorityChipClass(i.priority)}`}>P{i.priority}</span> : <span className="muted">—</span>}</td>
            <td style={{ width: 110 }}>{i.state ? <span className={`chip ${window.stateChipClass(table, i.state)}`}>{window.decodeChoice(table, 'state', i.state).label || i.state}</span> : <span className="muted">—</span>}</td>
            <td className="num muted" style={{ width: 90 }}>{window.fmtRelative(i.sys_updated_on)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Helper: bucket task records by their table for a sys_id-based field
// (e.g. `assignment_group`, `cmdb_ci`, `caller_id`, `requested_for`).
// Issues one /api/<table>?<field>=<sys_id> query per table in parallel and
// returns the non-empty buckets in input order.
//
// History: an older version filtered eager-loaded arrays in memory for any
// non-`incident` table. That silently dropped every non-incident bucket
// because the eager arrays for sc_request/sc_req_item/sc_task/etc. are
// declared `[]` in data.js but never populated (lazy by design — see the
// EAGER_TABLES list there). Switching everything to the API also handles
// per-relationship fan-out from the user record page cleanly.
async function bucketTaskRecordsAsync(field, sys_id, { tables } = {}) {
  const ts = tables || window.TASK_TABLES || ['incident', 'change_request'];
  const data = window.HistoricalWowData;
  const results = await Promise.all(ts.map(t =>
    data.fetchTaskList(t, {
      limit: 12, filters: { [field]: sys_id },
      order_by: 'sys_updated_on', dir: 'desc',
    }).then(res => (res.rows && res.rows.length)
      ? { table: t, items: res.rows, total: res.total }
      : null
    ).catch(() => null)
  ));
  return results.filter(Boolean);
}

window.GroupRefPage = function GroupRefPage({ sys_id }) {
  const data = window.HistoricalWowData;
  const g = window.findGroup(sys_id);
  const [taskBuckets, setTaskBuckets] = React.useState(null);  // null = loading
  React.useEffect(() => {
    if (g) window.AuditLog.push('view', `sys_user_group/${g.name}`, g.name);
    let cancel = false;
    setTaskBuckets(null);
    bucketTaskRecordsAsync('assignment_group', sys_id)
      .then(b => { if (!cancel) setTaskBuckets(b); })
      .catch(() => { if (!cancel) setTaskBuckets([]); });
    return () => { cancel = true; };
  }, [sys_id]);
  if (!g) return <div className="empty">Group not in snapshot.</div>;

  return (
    <div className="ref-page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--fg-3)', marginBottom: 14 }}>
        <a onClick={() => window.navigate('/groups')}>Groups</a>
        <window.Icon name="chevron_right" size={11} /><span>{g.name}</span>
      </div>
      <div className="head">
        <div style={{ width: 56, height: 56, borderRadius: 12, background: 'var(--bg-3)', display: 'grid', placeItems: 'center', color: 'var(--fg-2)' }}>
          <window.Icon name="users" size={26} />
        </div>
        <div className="info">
          <h1>{g.name}</h1>
          <div className="meta">
            <span>{g.description}</span>
            <span style={{ color: 'var(--fg-4)' }}>·</span>
            <span>{g.member_sys_ids.length} members</span>
          </div>
        </div>
      </div>

      <div className="ref-grid">
        <div className="cell"><div className="label">Manager</div><div className="val">{g.manager ? <window.UserCell sys_id={g.manager} displayName={g.__display_manager} /> : '—'}</div></div>
        <div className="cell"><div className="label">Active</div><div className="val">{g.active ? 'true' : 'false'}</div></div>
        <div className="cell" style={{ gridColumn: '1 / -1' }}><div className="label">sys_id</div><div className="val mono" style={{ fontSize: 12, color: 'var(--fg-3)' }}>{g.sys_id}</div></div>
      </div>

      <div className="ref-section">
        <h2>Members <span className="count">{g.member_sys_ids.length}</span></h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
          {g.member_sys_ids.map(uid => {
            const u = window.findUser(uid);
            return (
              <div key={uid} onClick={() => window.navigate(`/users/${uid}`)}
                   style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer' }}>
                <window.Avatar name={u?.name} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{u?.name}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{u?.title}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {taskBuckets == null && (
        <div className="ref-section">
          <h2>Records assigned <span className="count">…</span></h2>
          <div style={{ color: 'var(--fg-4)', fontSize: 12.5 }}>
            <span className="dot-pulse" style={{ display: 'inline-block', marginRight: 8 }} />loading…
          </div>
        </div>
      )}
      {taskBuckets && taskBuckets.length === 0 && (
        <div className="ref-section">
          <h2>Records assigned <span className="count">0</span></h2>
          <div style={{ color: 'var(--fg-4)', fontSize: 12.5 }}>No records assigned to this group in the snapshot.</div>
        </div>
      )}
      {(taskBuckets || []).map(({ table: t, items, total }) => (
        <div key={t} className="ref-section">
          <h2>{window.taskLabel(t, 'plural')} assigned <span className="count">{(total ?? items.length).toLocaleString()}</span></h2>
          <SmallIncTable incidents={items.slice(0, 12)} table={t} />
        </div>
      ))}
    </div>
  );
};

window.CIRefPage = function CIRefPage({ sys_id }) {
  const data = window.HistoricalWowData;
  // The compact CI from the eager lookup map has name + class + status;
  // fetch the full record (location, serial, etc.) and the relations on mount.
  const slim = window.findCI(sys_id);
  const [full, setFull] = React.useState(null);
  const [relations, setRelations] = React.useState({ upstream: null, downstream: null });
  const [taskBuckets, setTaskBuckets] = React.useState(null);
  const [linkedAsset, setLinkedAsset] = React.useState(null);
  React.useEffect(() => {
    if (slim) window.AuditLog.push('view', `cmdb_ci/${slim.name}`, slim.name);
    let cancel = false;
    setFull(null); setRelations({ upstream: null, downstream: null }); setTaskBuckets(null);
    setLinkedAsset(null);
    data.fetchRecord('cmdb_ci', sys_id).then(r => { if (!cancel) setFull(r); }).catch(() => {});
    data.fetchCIRelations(sys_id).then(r => { if (!cancel) setRelations(r); }).catch(() => setRelations({ upstream: [], downstream: [] }));
    bucketTaskRecordsAsync('cmdb_ci', sys_id)
      .then(b => { if (!cancel) setTaskBuckets(b); })
      .catch(() => { if (!cancel) setTaskBuckets([]); });
    // Reverse: any alm_hardware row whose `ci` field points back here.
    data.fetchTaskList('alm_hardware', { limit: 1, filters: { ci: sys_id } })
      .then(r => { if (!cancel) setLinkedAsset(r.rows?.[0] || false); })
      .catch(() => { if (!cancel) setLinkedAsset(false); });
    return () => { cancel = true; };
  }, [sys_id]);

  const c = full || slim;
  if (!c) return <div className="empty">CI not in snapshot.</div>;
  const upstream   = relations.upstream   || [];
  const downstream = relations.downstream || [];

  return (
    <div className="ref-page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--fg-3)', marginBottom: 14 }}>
        <a onClick={() => window.navigate('/cis')}>Configuration items</a>
        <window.Icon name="chevron_right" size={11} /><span className="mono">{c.name}</span>
      </div>
      <div className="head">
        <div style={{ width: 56, height: 56, borderRadius: 12, background: 'var(--bg-3)', display: 'grid', placeItems: 'center', color: 'var(--fg-2)' }}>
          <window.Icon name="ci" size={26} />
        </div>
        <div className="info">
          <h1 className="mono" style={{ fontFamily: 'var(--font-mono)', fontSize: 18 }}>{c.name}</h1>
          <div className="meta">
            <span className={`chip ${c.operational_status === 'Operational' ? 'green' : c.operational_status === 'Degraded' ? 'amber' : 'red'}`}>{c.operational_status}</span>
            <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-4)' }}>{c.sys_class_name}</span>
          </div>
        </div>
      </div>

      <div className="ref-grid">
        <div className="cell"><div className="label">Owned by</div><div className="val">{c.owned_by ? <span className="ref-link" onClick={() => window.navigate(`/groups/${c.owned_by}`)}>{window.findGroup(c.owned_by)?.name}</span> : '—'}</div></div>
        <div className="cell"><div className="label">Company</div><div className="val">{window.findCompany(c.company)?.name}</div></div>
        <div className="cell"><div className="label">Location</div><div className="val">{window.findLocation(c.location)?.name}</div></div>
        <div className="cell"><div className="label">Serial</div><div className="val mono" style={{ fontSize: 12.5 }}>{c.serial_number}</div></div>
        <div className="cell">
          <div className="label">Asset record</div>
          <div className="val">
            {linkedAsset === null ? <span style={{ color: 'var(--fg-4)' }}>…</span>
              : linkedAsset
                ? <span className="ref-link" onClick={() => window.navigate(`/hardware/${linkedAsset.sys_id}`)}>
                    {linkedAsset.asset_tag || linkedAsset.display_name || linkedAsset.sys_id.slice(0, 8) + '…'}
                  </span>
                : <span style={{ color: 'var(--fg-4)' }}>—</span>}
          </div>
        </div>
        <div className="cell" style={{ gridColumn: '1 / -1' }}><div className="label">Description</div><div className="val">{c.short_description}</div></div>
      </div>

      <div className="ref-section">
        <h2>Upstream dependencies <span className="count">{upstream.length}</span></h2>
        {upstream.length === 0 ? <div style={{ color: 'var(--fg-4)', fontSize: 12.5 }}>None recorded.</div> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {upstream.map(u => (
              <div key={u.rel.sys_id} onClick={() => window.navigate(`/cis/${u.ci.sys_id}`)}
                   style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', cursor: 'pointer' }}>
                <window.Icon name="arrow_right" size={12} />
                <span className="mono" style={{ fontSize: 12.5 }}>{u.ci.name}</span>
                <span style={{ color: 'var(--fg-4)', fontSize: 11.5, marginLeft: 'auto' }}>{u.rel.type}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="ref-section">
        <h2>Downstream <span className="count">{downstream.length}</span></h2>
        {downstream.length === 0 ? <div style={{ color: 'var(--fg-4)', fontSize: 12.5 }}>None recorded.</div> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {downstream.map(d => (
              <div key={d.rel.sys_id} onClick={() => window.navigate(`/cis/${d.ci.sys_id}`)}
                   style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', cursor: 'pointer' }}>
                <window.Icon name="arrow_right" size={12} />
                <span className="mono" style={{ fontSize: 12.5 }}>{d.ci.name}</span>
                <span style={{ color: 'var(--fg-4)', fontSize: 11.5, marginLeft: 'auto' }}>{d.rel.type}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {taskBuckets == null && (
        <div className="ref-section">
          <h2>Records on this CI <span className="count">…</span></h2>
          <div style={{ color: 'var(--fg-4)', fontSize: 12.5 }}>
            <span className="dot-pulse" style={{ display: 'inline-block', marginRight: 8 }} />loading…
          </div>
        </div>
      )}
      {taskBuckets && taskBuckets.length === 0 && (
        <div className="ref-section">
          <h2>Records on this CI <span className="count">0</span></h2>
          <div style={{ color: 'var(--fg-4)', fontSize: 12.5 }}>No records reference this CI in the snapshot.</div>
        </div>
      )}
      {(taskBuckets || []).map(({ table: t, items, total }) => (
        <div key={t} className="ref-section">
          <h2>{window.taskLabel(t, 'plural')} on this CI <span className="count">{(total ?? items.length).toLocaleString()}</span></h2>
          <SmallIncTable incidents={items} table={t} />
        </div>
      ))}
    </div>
  );
};
