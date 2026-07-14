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
          Read-only archive of <span className="mono" style={{ fontSize: 12.5 }}>{data.manifest.instance || 'the source ServiceNow instance'}</span>.
          Incidents, change requests, and all referenced context (users, groups, CIs, choices) — captured for the
          archival exit. No writes. No backfill.
          {' '}
          <a href="/docs/" style={{ color: 'var(--accent)', textDecoration: 'none', whiteSpace: 'nowrap' }}>
            API &amp; schema reference →
          </a>
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
// then catalog tasks first (richest detail) → requested items → requests
// last, then asset-task siblings.
const USER_TABLE_ORDER = ['incident', 'sc_task', 'sc_req_item', 'sc_request', 'sn_contract_renewal_task'];

// sys_user_delegate scope flags, in display order. ServiceNow lets a delegation
// cover any subset of these four. The viewer shows whichever are flagged on.
// Exposed on window so the standalone delegations list (lists.jsx) shares this
// one definition — the field names are instance-specific (plural here), so a
// second copy would be a divergence waiting to happen.
const DELEGATION_SCOPES = window.DELEGATION_SCOPES = [
  ['approvals',     'Approvals'],
  ['assignments',   'Assignments'],
  ['notifications', 'CC notifications'],
  ['invitations',   'Meeting invitations'],
];
// Robust truthiness for the scope flags: the merged envelope gives a real
// boolean (flatten coerces 'true'/'false'), but a row served straight from the
// indexed column would be the string '1'/'0' — and '0' is truthy. Normalise.
const delegationOn = window.delegationOn = v => v === true || v === 'true' || v === 1 || v === '1';

// One direction of a user's delegations. `otherField` is the column holding the
// *other* party — 'delegate' when this user is delegating out, 'user' when this
// user is receiving. Each card shows that party, the active window, and scopes.
function DelegationList({ rows, otherField }) {
  if (!rows || rows.length === 0) {
    return <div style={{ color: 'var(--fg-4)', fontSize: 12.5 }}>None.</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {rows.map(d => {
        const scopes = DELEGATION_SCOPES.filter(([k]) => delegationOn(d[k]));
        return (
          <div key={d.sys_id}
               style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <window.UserCell sys_id={d[otherField]} displayName={d['__display_' + otherField]} />
              <span className="mono" style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--fg-3)' }}>
                {d.starts || '—'} → {d.ends || 'open'}
              </span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {scopes.length === 0
                ? <span style={{ color: 'var(--fg-4)', fontSize: 11.5 }}>no scopes flagged</span>
                : scopes.map(([k, label]) => (
                    <span key={k} className="chip" style={{ fontSize: 10.5 }}>{label}</span>
                  ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Role grants for a user (sys_user_has_role) or group (sys_group_has_role).
// `resp` is the fetchTaskList response ({rows,total}); `inheritedField` is
// 'inherited' (user) or 'inherits' (group). Role names come from the reference
// display value. Shows direct + inherited (dimmed) chips, and flags truncation
// when more rows exist than were fetched (privileged accounts can have many).
function RolesSection({ resp, inheritedField, title }) {
  if (!resp || !resp.rows || resp.rows.length === 0) return null;
  const named = resp.rows
    .map(r => ({ name: r.__display_role || r.role, inherited: delegationOn(r[inheritedField]) }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const direct = named.filter(r => !r.inherited);
  const inh = named.filter(r => r.inherited);
  const truncated = resp.rows.length < (resp.total || 0);
  return (
    <div className="ref-section">
      <h2>{title} <span className="count">{(resp.total || resp.rows.length).toLocaleString()}</span></h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {direct.map((r, i) => (
          <span key={'d' + i} className="chip" style={{ fontSize: 11.5 }}>
            <window.Icon name="shield" size={11} />{r.name}
          </span>
        ))}
        {inh.map((r, i) => (
          <span key={'i' + i} className="chip" title="inherited" style={{ fontSize: 11.5, color: 'var(--fg-4)' }}>{r.name}</span>
        ))}
      </div>
      {(inh.length > 0 || truncated) && (
        <div style={{ fontSize: 11, color: 'var(--fg-4)', marginTop: 6 }}>
          {direct.length} direct · {inh.length} inherited (dimmed){truncated ? ` · showing first ${resp.rows.length} of ${resp.total.toLocaleString()}` : ''}
        </div>
      )}
    </div>
  );
}

// A compact clickable row for the user-page "related records" sections.
function RefRow({ onClick, children }) {
  return (
    <div onClick={onClick}
         style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
                  background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 6,
                  cursor: onClick ? 'pointer' : 'default', fontSize: 12.5 }}>
      {children}
    </div>
  );
}

// User-page section: fetch <table> where <field> = the user, render each row
// via renderRow. Hidden while loading and when empty; keeps the API total to
// flag truncation.
function RelatedRecordsSection({ title, table, field, sys_id, slim, orderBy, dir, renderRow }) {
  const data = window.HistoricalWowData;
  const [resp, setResp] = React.useState(null);
  React.useEffect(() => {
    let cancel = false; setResp(null);
    const opts = { limit: 100, filters: { [field]: sys_id } };
    // orderBy must be an indexed column — the server ignores non-indexed
    // order_by and falls back to sys_id, which would make the truncated
    // first-100 arbitrary rather than ordered.
    if (orderBy) { opts.order_by = orderBy; opts.dir = dir || 'desc'; }
    if (slim) opts.slim = 1;
    data.fetchTaskList(table, opts)
      .then(r => { if (!cancel) setResp(r); })
      .catch(() => { if (!cancel) setResp({ rows: [], total: 0 }); });
    return () => { cancel = true; };
  }, [table, field, sys_id]);
  if (!resp || !resp.rows || resp.rows.length === 0) return null;
  const truncated = resp.rows.length < (resp.total || 0);
  return (
    <div className="ref-section">
      <h2>{title} <span className="count">{(resp.total || resp.rows.length).toLocaleString()}</span></h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {resp.rows.map(renderRow)}
      </div>
      {truncated && <div style={{ fontSize: 11, color: 'var(--fg-4)', marginTop: 6 }}>showing first {resp.rows.length} of {resp.total.toLocaleString()}</div>}
    </div>
  );
}

// Record view for a sys_template — the generic RecordPage is task-shaped and
// renders blank for templates, so show the target table, owner, and the field
// values it pre-fills (parsed from the encoded `template` string).
window.TemplateRecordPage = function TemplateRecordPage({ sys_id }) {
  const data = window.HistoricalWowData;
  const [rec, setRec] = React.useState(undefined);
  React.useEffect(() => {
    let cancel = false;
    data.fetchRecord('sys_template', sys_id)
      .then(r => { if (!cancel) setRec(r || null); })
      .catch(() => { if (!cancel) setRec(null); });
    if (window.AuditLog) window.AuditLog.push('view', `sys_template/${sys_id}`, '');
    return () => { cancel = true; };
  }, [sys_id]);
  if (rec === undefined) return <div style={{ padding: 24, color: 'var(--fg-4)', fontSize: 12.5 }}><span className="dot-pulse" style={{ display: 'inline-block', marginRight: 8 }} />loading…</div>;
  if (!rec) return <div className="empty"><div className="glyph"><window.Icon name="info" /></div>Template not in this snapshot.</div>;
  // `template` encodes field=value pairs joined by `^` (with trailing query
  // operators like EQ). Parse into rows, skipping operator tokens.
  const pairs = String(rec.template || '').split('^')
    .map(s => s.trim())
    .filter(s => s.includes('=') && !/^(EQ|NQ|OR|ORDERBY|GOTO)\b/i.test(s))
    .map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; });
  return (
    <div className="ref-page">
      <div className="crumbs" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--fg-3)', marginBottom: 14 }}>
        <span>Template</span>
        <window.Icon name="chevron_right" size={11} />
        <span className="mono">{rec.name}</span>
      </div>
      <div className="head" style={{ display: 'block' }}>
        <h1 style={{ marginBottom: 8 }}>{rec.name || '(unnamed)'}</h1>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {rec.table && <span className="chip mono">{rec.table}</span>}
          {rec.active === false && <span className="chip" style={{ color: 'var(--fg-4)' }}>inactive</span>}
        </div>
      </div>
      <div className="ref-grid" style={{ marginTop: 14 }}>
        <div className="cell"><div className="label">Target table</div><div className="val mono">{rec.table || '—'}</div></div>
        <div className="cell"><div className="label">Owner</div><div className="val">{rec.user ? <window.UserCell sys_id={rec.user} displayName={rec.__display_user} /> : '—'}</div></div>
        <div className="cell"><div className="label">Short description</div><div className="val">{rec.short_description || '—'}</div></div>
        <div className="cell"><div className="label">Updated</div><div className="val">{rec.sys_updated_on || '—'}</div></div>
      </div>
      <div className="ref-section">
        <h2>Sets fields <span className="count">{pairs.length}</span></h2>
        {pairs.length === 0
          ? <div style={{ color: 'var(--fg-4)', fontSize: 12.5 }}>No field values parsed from this template.</div>
          // table-layout:fixed keeps the table inside the .ref-page width cap;
          // each value renders on one line (no wrap = faithful to the stored
          // value) inside a box that scrolls horizontally, so a long value
          // can't stretch the column — and therefore the page — to fit.
          : <table className="dt" style={{ tableLayout: 'fixed' }}>
              <thead><tr><th style={{ width: 220 }}>Field</th><th>Value</th></tr></thead>
              <tbody>{pairs.map(([k, v], i) => (
                <tr key={i} style={{ cursor: 'default' }}>
                  <td className="mono" style={{ fontSize: 12, verticalAlign: 'top' }}>{k}</td>
                  <td style={{ padding: 0 }}>
                    <div className="mono" style={{ overflowX: 'auto', whiteSpace: 'pre', fontSize: 11.5, color: 'var(--fg-2)', padding: '10px 12px' }}>{v || '—'}</div>
                  </td>
                </tr>
              ))}</tbody>
            </table>}
      </div>
    </div>
  );
};

// SLA performance for a user (their incidents) or group (its incidents) — from
// the /api/sla-stats endpoint (task_sla joined to incident). Hidden when the
// record has no incident SLAs.
function SlaStatsSection({ kind, sys_id }) {
  const [stats, setStats] = React.useState(null);
  React.useEffect(() => {
    let cancel = false; setStats(null);
    window.HistoricalWowData.fetchSlaStats(kind, sys_id)
      .then(s => { if (!cancel) setStats(s); })
      .catch(() => { if (!cancel) setStats({ total: 0, breached: 0, by_stage: {} }); });
    return () => { cancel = true; };
  }, [kind, sys_id]);
  if (!stats || !stats.total) return null;
  const rate = stats.total ? Math.round((stats.breached / stats.total) * 100) : 0;
  const stages = Object.entries(stats.by_stage).sort((a, b) => b[1] - a[1]);
  return (
    <div className="ref-section">
      <h2>SLA performance <span className="count">{stats.total.toLocaleString()}</span></h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>incident SLAs ·</span>
        {stats.breached > 0
          ? <span className="chip red" style={{ fontSize: 10.5 }}>{stats.breached.toLocaleString()} breached ({rate}%)</span>
          : <span className="chip green" style={{ fontSize: 10.5 }}>none breached</span>}
        {stages.map(([stage, n]) => (
          <span key={stage} className="chip" style={{ fontSize: 10.5 }}>{stage}: {n.toLocaleString()}</span>
        ))}
      </div>
    </div>
  );
}

window.UserRefPage = function UserRefPage({ sys_id }) {
  const data = window.HistoricalWowData;
  const u = window.findUser(sys_id);
  // relations: null while loading; otherwise { [field]: [{table, items, total}, ...] }
  const [relations, setRelations]   = React.useState(null);
  const [hwAssigned, setHwAssigned] = React.useState(null);
  const [hwOwned, setHwOwned]       = React.useState(null);
  // delegations: null while loading; otherwise { given: {rows,total}, received: {rows,total} }
  const [delegations, setDelegations] = React.useState(null);
  // roles: null while loading; otherwise this user's sys_user_has_role rows
  const [roles, setRoles] = React.useState(null);
  // Full envelope record. findUser() returns the compact lookup map, which
  // only carries name/user_name/title/department/location — so email,
  // company, cost_center, active and sys_updated_on have to come from the
  // full record fetch (same pattern as CIRefPage), or they render blank/false.
  const [full, setFull] = React.useState(null);

  React.useEffect(() => {
    if (u) window.AuditLog.push('view', `sys_user/${u.user_name}`, u.name);
    let cancel = false;
    setRelations(null);
    setHwAssigned(null); setHwOwned(null);
    setDelegations(null);
    setRoles(null);
    setFull(null);
    data.fetchRecord('sys_user', sys_id).then(rec => { if (!cancel) setFull(rec); }).catch(() => {});
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
    // Delegations in both directions: `user`=this user → they delegate out;
    // `delegate`=this user → they receive someone else's delegation.
    const noRows = { rows: [], total: 0 };
    Promise.all([
      data.fetchTaskList('sys_user_delegate', { limit: 100, filters: { user: sys_id },     order_by: 'starts', dir: 'desc' }).catch(() => noRows),
      data.fetchTaskList('sys_user_delegate', { limit: 100, filters: { delegate: sys_id }, order_by: 'starts', dir: 'desc' }).catch(() => noRows),
    ]).then(([given, received]) => { if (!cancel) setDelegations({ given, received }); });
    // Roles held (direct + inherited). Non-slim so the role name arrives as the
    // reference display value (__display_role).
    data.fetchTaskList('sys_user_has_role', { limit: 1000, filters: { user: sys_id }, order_by: 'role', dir: 'asc' })
      .then(r => { if (!cancel) setRoles(r); }).catch(() => { if (!cancel) setRoles({ rows: [], total: 0 }); });
    return () => { cancel = true; };
  }, [sys_id]);

  if (!u) return <div className="empty"><div className="glyph"><window.Icon name="info" /></div>User not in snapshot.</div>;

  // Only trust `full` when it's this user's record: navigating A→B reuses the
  // component, so `full` still holds A until the [sys_id] effect re-runs after
  // paint — guarding on its own sys_id stops B's page flashing A's details.
  const fullReady = full && full.sys_id === sys_id;
  const r = fullReady ? full : u;
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
            <span>{r.email}</span>
          </div>
        </div>
      </div>

      <div className="ref-grid">
        <div className="cell"><div className="label">Manager</div><div className="val">{r.manager ? <window.UserCell sys_id={r.manager} displayName={r.__display_manager} /> : '—'}</div></div>
        <div className="cell"><div className="label">Department</div><div className="val">{window.findDepartment(r.department)?.name || r.__display_department || '—'}</div></div>
        <div className="cell"><div className="label">Location</div><div className="val">{r.location ? <span className="ref-link" onClick={() => window.navigate(window.recordUrl('cmn_location', r.location))}>{window.findLocation(r.location)?.name || r.__display_location || (String(r.location).slice(0, 8) + '…')}</span> : '—'}</div></div>
        {(() => {
          const cc = window.findCostCenter(r.cost_center) ||
                     window.findCostCenter(window.findDepartment(r.department)?.cost_center);
          return (
            <div className="cell">
              <div className="label">Cost center</div>
              <div className="val">{cc ? `${cc.name}${cc.code ? ` · ${cc.code}` : ''}` : (r.__display_cost_center || '—')}</div>
            </div>
          );
        })()}
        <div className="cell"><div className="label">Mobile</div><div className="val">{r.mobile_phone || r.phone || '—'}</div></div>
        <div className="cell"><div className="label">Active</div><div className="val">{fullReady ? (r.active ? 'true' : 'false') : '…'}</div></div>
        <div className="cell"><div className="label">Created</div><div className="val">{r.sys_created_on || '—'}</div></div>
        <div className="cell"><div className="label">Last updated</div><div className="val">{r.sys_updated_on || '—'}</div></div>
        <div className="cell" style={{ gridColumn: '1 / -1' }}><div className="label">sys_id</div><div className="val mono" style={{ fontSize: 12, color: 'var(--fg-3)' }}>{u.sys_id}</div></div>
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

      {roles != null && <RolesSection resp={roles} inheritedField="inherited" title="Roles" />}

      {delegations != null && (delegations.given.total > 0 || delegations.received.total > 0) && (
        <div className="ref-section">
          <h2>Delegations <span className="count">{(delegations.given.total + delegations.received.total).toLocaleString()}</span></h2>
          {delegations.given.total > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 12.5, color: 'var(--fg-3)', marginBottom: 6, fontWeight: 500 }}>
                · delegating to others <span className="count">{delegations.given.total.toLocaleString()}</span>
              </div>
              <DelegationList rows={delegations.given.rows} otherField="delegate" />
            </div>
          )}
          {delegations.received.total > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 12.5, color: 'var(--fg-3)', marginBottom: 6, fontWeight: 500 }}>
                · receiving from others <span className="count">{delegations.received.total.toLocaleString()}</span>
              </div>
              <DelegationList rows={delegations.received.rows} otherField="user" />
            </div>
          )}
        </div>
      )}

      <RelatedRecordsSection title="Templates" table="sys_template" field="user" sys_id={sys_id} slim orderBy="name" dir="asc"
        renderRow={t => (
          <RefRow key={t.sys_id} onClick={() => window.navigate(window.recordUrl('sys_template', t.sys_id))}>
            <window.Icon name="file" size={13} />
            <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
            <span className="mono" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--fg-4)' }}>{t.table || ''}</span>
          </RefRow>
        )} />

      <RelatedRecordsSection title="Knowledge authored" table="kb_knowledge" field="author" sys_id={sys_id} slim orderBy="number"
        renderRow={a => (
          <RefRow key={a.sys_id} onClick={() => window.navigate(`/knowledge/${a.sys_id}`)}>
            <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{a.number}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.short_description}</span>
          </RefRow>
        )} />

      <RelatedRecordsSection title="Approvals" table="sysapproval_approver" field="approver" sys_id={sys_id} orderBy="sys_created_on"
        renderRow={a => (
          <RefRow key={a.sys_id}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.__display_sysapproval || a.sysapproval || '—'}</span>
            <span className="chip" style={{ marginLeft: 'auto', fontSize: 10.5 }}>{a.__display_state || a.state || '—'}</span>
          </RefRow>
        )} />

      <RelatedRecordsSection title="CIs owned" table="cmdb_ci" field="owned_by" sys_id={sys_id} slim orderBy="name" dir="asc"
        renderRow={c => (
          <RefRow key={c.sys_id} onClick={() => window.navigate(`/cis/${c.sys_id}`)}>
            <window.Icon name="ci" size={12} />
            <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
            <span className="mono" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--fg-4)' }}>{c.sys_class_name || ''}</span>
          </RefRow>
        )} />

      <SlaStatsSection kind="user" sys_id={sys_id} />

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
  const [roles, setRoles] = React.useState(null);              // roles this group grants
  React.useEffect(() => {
    if (g) window.AuditLog.push('view', `sys_user_group/${g.name}`, g.name);
    let cancel = false;
    setTaskBuckets(null);
    setRoles(null);
    bucketTaskRecordsAsync('assignment_group', sys_id)
      .then(b => { if (!cancel) setTaskBuckets(b); })
      .catch(() => { if (!cancel) setTaskBuckets([]); });
    data.fetchTaskList('sys_group_has_role', { limit: 1000, filters: { group: sys_id }, order_by: 'role', dir: 'asc' })
      .then(r => { if (!cancel) setRoles(r); }).catch(() => { if (!cancel) setRoles({ rows: [], total: 0 }); });
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

      {roles != null && <RolesSection resp={roles} inheritedField="inherits" title="Roles granted" />}

      <SlaStatsSection kind="group" sys_id={sys_id} />

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

  // Same cross-record guard as UserRefPage: ignore a prior CI's full record
  // while navigating between CIs until the [sys_id] effect re-runs.
  const c = (full && full.sys_id === sys_id) ? full : slim;
  if (!c) return <div className="empty">CI not in snapshot.</div>;
  const upstream   = relations.upstream   || [];
  const downstream = relations.downstream || [];
  // operational_status is a coded value ('1'); the full record carries the
  // label in __display_operational_status. (The compact lookup stub only has
  // the code, so it can briefly read as the code until the full record loads.)
  const opLabel = c.__display_operational_status || c.operational_status;
  const opCls = opLabel === 'Operational' ? 'green' : opLabel === 'Degraded' ? 'amber'
              : (opLabel === 'Down' || opLabel === 'Non-Operational') ? 'red' : '';

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
            {opLabel ? <span className={`chip ${opCls}`}>{opLabel}</span> : null}
            <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-4)' }}>{c.__display_sys_class_name || c.sys_class_name}</span>
          </div>
        </div>
      </div>

      <div className="ref-grid">
        <div className="cell"><div className="label">Install status</div><div className="val">{c.__display_install_status || c.install_status || '—'}</div></div>
        <div className="cell"><div className="label">Discovery source</div><div className="val">{c.discovery_source || '—'}</div></div>
        <div className="cell"><div className="label">Last discovered</div><div className="val mono" style={{ fontSize: 12.5 }}>{c.last_discovered ? window.fmtDate(c.last_discovered) : '—'}</div></div>
        {/* owned_by is a sys_user reference (not a group) — show the resolved name and link to the user page */}
        <div className="cell"><div className="label">Owned by</div><div className="val">{c.owned_by ? <span className="ref-link" onClick={() => window.navigate(`/users/${c.owned_by}`)}>{c.__display_owned_by || window.findUser(c.owned_by)?.name || c.owned_by}</span> : '—'}</div></div>
        <div className="cell"><div className="label">Support group</div><div className="val">{c.support_group ? <span className="ref-link" onClick={() => window.navigate(`/groups/${c.support_group}`)}>{c.__display_support_group || window.findGroup(c.support_group)?.name || c.support_group}</span> : '—'}</div></div>
        <div className="cell"><div className="label">Company</div><div className="val">{window.findCompany(c.company)?.name || c.__display_company || '—'}</div></div>
        <div className="cell"><div className="label">Location</div><div className="val">{c.location ? <span className="ref-link" onClick={() => window.navigate(window.recordUrl('cmn_location', c.location))}>{window.findLocation(c.location)?.name || c.__display_location || (String(c.location).slice(0, 8) + '…')}</span> : '—'}</div></div>
        <div className="cell"><div className="label">IP address</div><div className="val mono" style={{ fontSize: 12.5 }}>{c.ip_address || '—'}</div></div>
        <div className="cell"><div className="label">FQDN</div><div className="val mono" style={{ fontSize: 12.5 }}>{c.fqdn || '—'}</div></div>
        <div className="cell"><div className="label">Serial</div><div className="val mono" style={{ fontSize: 12.5 }}>{c.serial_number || '—'}</div></div>
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
        <div className="cell" style={{ gridColumn: '1 / -1' }}><div className="label">Description</div><div className="val">{c.short_description || '—'}</div></div>
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
                <span style={{ color: 'var(--fg-4)', fontSize: 11.5, marginLeft: 'auto' }}>{u.rel.__display_type || u.rel.type}</span>
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
                <span style={{ color: 'var(--fg-4)', fontSize: 11.5, marginLeft: 'auto' }}>{d.rel.__display_type || d.rel.type}</span>
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

// =========================================================================
// CMDB overview / metrics dashboard (/cmdb)
// =========================================================================
// Renders the precomputed /api/cmdb/metrics aggregates. Segments deep-link
// into the CI list with a hash query (#/cis?sys_class_name=…) for the
// dimensions that are server-side filterable (indexed columns); the rest are
// informational. Matches the Logic/Catalog overview house style.

function CmdbTile({ label, value, sub, accent, onClick }) {
  return (
    <div onClick={onClick} style={{
      background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8,
      padding: '12px 14px', cursor: onClick ? 'pointer' : 'default',
      borderLeft: `3px solid ${accent || 'var(--border-strong)'}`,
    }}>
      <div style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-.02em', marginTop: 4, fontFamily: 'var(--font-mono)' }}>
        {value == null ? '—' : value.toLocaleString()}
      </div>
      {sub != null && <div style={{ fontSize: 11, color: 'var(--fg-4)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// Horizontal bar list. `items`: [{value,label,count}]. `linkFor(item)` returns
// a hash path to deep-link the row (or null for non-filterable rows).
function CmdbBars({ title, sub, items, color, total, linkFor, limit, emptyNote }) {
  const [expanded, setExpanded] = React.useState(false);
  const allRows = items || [];
  const rows = limit && !expanded ? allRows.slice(0, limit) : allRows;
  const max = rows.reduce((a, r) => Math.max(a, r.count), 0) || 1;
  return (
    <div>
      <h2 style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--fg-3)', margin: '0 0 10px' }}>
        {title}
        {sub && <span className="mono" style={{ color: 'var(--fg-4)', marginLeft: 8, textTransform: 'none', letterSpacing: 0 }}>{sub}</span>}
      </h2>
      <div style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 0', overflow: 'hidden' }}>
        {rows.length === 0 && <div style={{ padding: 18, color: 'var(--fg-4)', fontSize: 12.5, textAlign: 'center' }}>{emptyNote || 'No data.'}</div>}
        {rows.map((r, i) => {
          const href = linkFor && linkFor(r);
          const pct = total ? Math.round((r.count / total) * 1000) / 10 : null;
          return (
            <div key={r.value != null ? r.value + ':' + i : i}
              onClick={href ? () => window.navigate(href) : undefined}
              style={{ display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: 10,
                       padding: '5px 14px', cursor: href ? 'pointer' : 'default' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, marginBottom: 3 }}>
                  <span className="truncate" style={{ color: href ? 'var(--accent-2)' : 'var(--fg-2)' }}>{r.label}</span>
                  <span className="mono" style={{ color: 'var(--fg-4)', flexShrink: 0 }}>{r.count.toLocaleString()}{pct != null && pct >= 0.1 ? ` · ${pct}%` : ''}</span>
                </div>
                <div style={{ height: 4, borderRadius: 2, background: 'var(--bg-deep, var(--border))' }}>
                  <div style={{ width: `${Math.max(1, (r.count / max) * 100)}%`, height: '100%', borderRadius: 2, background: color || 'var(--accent)' }} />
                </div>
              </div>
            </div>
          );
        })}
        {limit && allRows.length > limit && (
          <button className="analytics-show-all" onClick={() => setExpanded(v => !v)}>
            {expanded ? `Show top ${limit}` : `Show all ${allRows.length.toLocaleString()}`}
          </button>
        )}
      </div>
    </div>
  );
}

window.CMDBOverviewPage = function CMDBOverviewPage() {
  const data = window.HistoricalWowData;
  const [m, setM] = React.useState(null);
  const [err, setErr] = React.useState(false);

  React.useEffect(() => {
    if (window.AuditLog) window.AuditLog.push('view', 'cmdb', 'CMDB overview');
    let cancel = false;
    data.fetchCmdbMetrics().then(x => { if (!cancel) setM(x); }).catch(() => { if (!cancel) setErr(true); });
    return () => { cancel = true; };
  }, []);

  const wrap = (children) => (
    <div style={{ padding: '32px 32px 60px', maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 11.5, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '.08em', fontWeight: 600 }}>
          Configuration Management Database
        </div>
        <h1 style={{ margin: '6px 0 8px', fontSize: 26, fontWeight: 600, letterSpacing: '-0.02em' }}>CMDB overview</h1>
        <div style={{ color: 'var(--fg-3)', fontSize: 13.5, maxWidth: 780, lineHeight: 1.6 }}>
          Every configuration item in this snapshot, by class, status, discovery source, freshness,
          ownership, and relationship coverage. Click a class or status to open the filtered CI list.
        </div>
      </div>
      {children}
    </div>
  );

  if (err) return wrap(<div className="empty"><div className="glyph"><window.Icon name="info" /></div>CMDB metrics unavailable.</div>);
  if (!m) return wrap(<div style={{ padding: 40, color: 'var(--fg-4)' }}><span className="dot-pulse" style={{ display: 'inline-block', marginRight: 8 }} />computing metrics…</div>);

  const idx = new Set(m.indexed_columns || []);
  const byLabel = (arr, lbl) => (arr || []).find(d => d.label === lbl);
  const statusVal = (lbl) => { const d = byLabel(m.operational_status, lbl); return d ? d.value : null; };
  const bucket = (b) => { const d = (m.staleness || []).find(s => s.bucket === b); return d ? d.count : 0; };
  const stale90 = bucket('91-365d') + bucket('365d+');
  const rel = m.relationships || {};
  const bizApps = (m.classes || []).find(c => c.value === 'cmdb_ci_business_app');

  // deep-link helpers — only for filterable (indexed) dimensions
  const classLink = (r) => r.value ? `/cis?sys_class_name=${encodeURIComponent(r.value)}` : null;
  const opLink = (r) => r.value ? `/cis?operational_status=${encodeURIComponent(r.value)}` : null;
  const instLink = (r) => (idx.has('install_status') && r.value) ? `/cis?install_status=${encodeURIComponent(r.value)}` : null;
  const discoLink = (r) => (idx.has('discovery_source') && r.value) ? `/cis?discovery_source=${encodeURIComponent(r.value)}` : null;

  const tile = { display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 12, marginBottom: 26 };
  const owned = (m.ownership && m.ownership.owned_by) || 0;
  // null = support_group not indexed yet (computed only once the column exists)
  const supported = m.ownership ? m.ownership.support_group : null;

  return wrap(
    <>
      <div style={tile}>
        <CmdbTile label="Configuration items" value={m.total} sub={`${m.classes ? m.classes.length : 0} classes`}
                  accent="var(--accent)" onClick={() => window.navigate('/cis')} />
        <CmdbTile label="Operational" value={(byLabel(m.operational_status, 'Operational') || {}).count}
                  accent="var(--accent)" onClick={statusVal('Operational') ? () => window.navigate(`/cis?operational_status=${statusVal('Operational')}`) : undefined} />
        <CmdbTile label="Retired" value={(byLabel(m.operational_status, 'Retired') || {}).count}
                  accent="var(--c-amber)" onClick={statusVal('Retired') ? () => window.navigate(`/cis?operational_status=${statusVal('Retired')}`) : undefined} />
        <CmdbTile label="Stale > 90 days" value={idx.has('last_discovered') ? stale90 : null} sub={idx.has('last_discovered') ? 'last discovered' : 'after next build'}
                  accent="var(--c-red)" onClick={idx.has('last_discovered') ? () => window.navigate('/cis?stale=stale90') : undefined} />
        <CmdbTile label="Orphans (no relationship)" value={rel.orphans} sub="not in cmdb_rel_ci" accent="var(--c-violet)" />
        <CmdbTile label="Business apps" value={bizApps ? bizApps.count : 0} sub={`${owned.toLocaleString()} owned`}
                  accent="var(--c-blue)" onClick={bizApps ? () => window.navigate('/cis?sys_class_name=cmdb_ci_business_app') : undefined} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 22, marginBottom: 24 }}>
        <CmdbBars title="CIs by class" sub="sys_class_name" items={m.classes} limit={15}
                  total={m.total} color="var(--accent)" linkFor={classLink} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <CmdbBars title="Operational status" items={m.operational_status} total={m.total} color="var(--c-blue)" linkFor={opLink} />
          <CmdbBars title="Install status" items={m.install_status} total={m.total} color="var(--c-violet)" linkFor={instLink}
                    emptyNote={idx.has('install_status') ? undefined : 'Available after the indexed-columns build'} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22, marginBottom: 24 }}>
        <CmdbBars title="Discovery source" sub="how the CI got here" items={m.discovery_source} total={m.total} color="var(--c-blue)" linkFor={discoLink}
                  emptyNote={idx.has('discovery_source') ? undefined : 'Available after the indexed-columns build'} />
        <div>
          <CmdbBars title="Freshness" sub="last_discovered vs snapshot"
                    items={(m.staleness || []).map(s => ({ value: s.bucket, label: s.bucket === 'never' ? 'never discovered' : s.bucket, count: s.count }))}
                    total={m.total} color="var(--c-amber)"
                    emptyNote={idx.has('last_discovered') ? undefined : 'Available after the indexed-columns build'} />
          {idx.has('last_discovered') && (
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <button className="filter-pill" onClick={() => window.navigate('/cis?stale=stale90')}>stale &gt; 90d →</button>
              <button className="filter-pill" onClick={() => window.navigate('/cis?stale=stale365')}>stale &gt; 1y →</button>
              <button className="filter-pill" onClick={() => window.navigate('/cis?stale=fresh7')}>fresh ≤ 7d →</button>
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22 }}>
        <div>
          <h2 style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--fg-3)', margin: '0 0 10px' }}>
            Ownership <span className="mono" style={{ color: 'var(--fg-4)', marginLeft: 8, textTransform: 'none', letterSpacing: 0 }}>two tiers</span>
          </h2>
          <div style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, padding: 16, fontSize: 12.5, lineHeight: 1.7 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', rowGap: 6 }}>
              <span style={{ color: 'var(--fg-3)' }}>Owned (owned_by) — the curated app tier</span>
              <span className="mono">{owned.toLocaleString()}</span>
              <span style={{ color: 'var(--fg-3)' }}>Supported (support_group) — the infra tier</span>
              <span className="mono">{supported == null ? '— (after next build)' : supported.toLocaleString()}</span>
              <span style={{ color: 'var(--fg-3)' }}>Total CIs</span>
              <span className="mono">{m.total.toLocaleString()}</span>
            </div>
          </div>
        </div>
        <div>
          <h2 style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--fg-3)', margin: '0 0 10px' }}>
            Relationships
            <span className="mono" style={{ color: 'var(--fg-4)', marginLeft: 8, textTransform: 'none', letterSpacing: 0 }}>
              {rel.connected != null ? `${rel.connected.toLocaleString()} of ${m.total.toLocaleString()} connected` : 'cmdb_rel_ci'}
            </span>
          </h2>
          <CmdbBars title="" items={rel.types} limit={10} total={rel.total_rels} color="var(--c-violet)" />
        </div>
      </div>
    </>
  );
};
