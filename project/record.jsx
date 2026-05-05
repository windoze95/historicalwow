/* eslint-disable */
// Record detail page — works for any task table (incident, change_request,
// problem, sc_request, sc_req_item, sc_task, sysapproval_group, …).

// Parent → child relationship map for the "Tasks" section. The link field
// varies by parent: incident uses generic `parent`, but the catalog flow
// uses `request` (sc_request → sc_req_item) and `request_item`
// (sc_req_item → sc_task). Without this, opening an RITM showed no child
// catalog tasks because we were filtering on `parent` (which is empty).
const CHILD_REL = {
  incident:        { table: 'incident_task', field: 'parent' },
  change_request:  { table: 'change_task',   field: 'parent' },
  problem:         { table: 'problem_task',  field: 'parent' },
  sc_request:      { table: 'sc_req_item',   field: 'request' },
  sc_req_item:     { table: 'sc_task',       field: 'request_item' },
};

window.RecordPage = function RecordPage({ table, sys_id, showRaw }) {
  const data = window.HistoricalWowData;
  const [tab, setTab] = React.useState('journal');
  // All record data fetched via API on mount. No eager-loaded incident list,
  // so we don't have a "slim" until the API responds.
  const [fullRec, setFullRec]   = React.useState(null);
  const [journals, setJournals] = React.useState(null);
  const [audits, setAudits]     = React.useState(null);
  const [atts, setAtts]         = React.useState(null);
  const [tasks, setTasks]       = React.useState([]);
  const [ciLinks, setCILinks]   = React.useState([]);
  const [slas, setSLAs]         = React.useState([]);
  const [approvals, setApprovals] = React.useState([]);
  const [variables, setVariables] = React.useState({ rows: [], cat_item: null });

  React.useEffect(() => {
    let cancel = false;
    setFullRec(null); setJournals(null); setAudits(null); setAtts(null);
    setTasks([]); setCILinks([]); setSLAs([]); setApprovals([]);
    setVariables({ rows: [], cat_item: null });

    data.fetchRecord(table, sys_id).then(r => {
      if (cancel) return;
      setFullRec(r);
      if (r) window.AuditLog.push('view', `${table}/${r.number}`, r.short_description);
    }).catch(e => {
      if (cancel) return;
      // 403 → HR gate. Render a friendly message rather than the loading
      // spinner forever.
      if (e && /403/.test(e.message || '')) {
        setFullRec({ __hr_locked: true, sys_id });
      } else {
        setFullRec(false);
      }
    });
    data.fetchJournalFor(sys_id).then(r => { if (!cancel) setJournals(r); }).catch(() => setJournals([]));
    data.fetchAuditFor(sys_id).then(r => { if (!cancel) setAudits(r); }).catch(() => setAudits([]));
    data.fetchAttachmentsFor(sys_id).then(r => { if (!cancel) setAtts(r); }).catch(() => setAtts([]));

    // Per-record relationships (each is a small filtered query — was eager-
    // loaded as 422k+90k+75k rows, now 0–N rows per record).
    const rel = CHILD_REL[table];
    if (rel) {
      data.fetchTaskList(rel.table, { filters: { [rel.field]: sys_id }, limit: 200, slim: 1 })
        .then(r => { if (!cancel) setTasks(r.rows || []); }).catch(() => {});
    }
    data.fetchTaskList('task_ci', { filters: { task: sys_id }, limit: 200 })
      .then(r => { if (!cancel) setCILinks(r.rows || []); }).catch(() => {});
    data.fetchTaskList('task_sla', { filters: { task: sys_id }, limit: 50 })
      .then(r => { if (!cancel) setSLAs(r.rows || []); }).catch(() => {});
    data.fetchTaskList('sysapproval_approver', { filters: { sysapproval: sys_id }, limit: 50 })
      .then(r => { if (!cancel) setApprovals(r.rows || []); }).catch(() => {});
    if (table === 'sc_req_item') {
      data.fetchVariables(sys_id)
        .then(r => { if (!cancel) setVariables(r); }).catch(() => {});
    }

    return () => { cancel = true; };
  }, [table, sys_id]);

  const rec = fullRec;
  if (rec === null) {
    return <div className="empty"><div className="dot-pulse" style={{ marginBottom: 12 }} />loading…</div>;
  }
  if (rec && rec.__hr_locked) {
    const label = data.hrStatus.group_label || 'this group';
    return (
      <div className="empty">
        <div className="glyph"><window.Icon name="lock" /></div>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>This record is restricted</div>
        <div style={{ maxWidth: 360, color: 'var(--fg-3)', fontSize: 13 }}>
          It belongs to <strong>{label}</strong>. Click <strong>Unlock HR data</strong> in the
          top bar to enter the access password and view it.
        </div>
      </div>
    );
  }
  if (!rec) {
    return <div className="empty"><div className="glyph"><window.Icon name="info" /></div>Record not found in this snapshot.</div>;
  }

  const journalCount = journals == null ? '…' : journals.length;
  const auditCount   = audits   == null ? '…' : audits.length;
  const attCount     = atts     == null ? '…' : atts.length;

  return (
    <div className="record">
      <div className="left">
        <RecordHeader rec={rec} table={table} />
        <FieldsSection rec={rec} table={table} showRaw={showRaw} />
        <VariablesSection rows={variables.rows} cat_item={variables.cat_item} />
        {tasks.length > 0 && <TasksSection tasks={tasks} table={table} />}
        {slas.length > 0 && <SLAsSection slas={slas} />}
        {ciLinks.length > 0 && <AffectedCIsSection ciLinks={ciLinks} />}
        {approvals.length > 0 && <ApprovalsSection approvals={approvals} />}
        <ManifestFooter rec={rec} />
      </div>
      <div className="right">
        <div className="tabs">
          <button className={'tab' + (tab === 'journal' ? ' active' : '')} onClick={() => setTab('journal')}>
            Journal <span className="badge">{journalCount}</span>
          </button>
          <button className={'tab' + (tab === 'audit' ? ' active' : '')} onClick={() => setTab('audit')}>
            History <span className="badge">{auditCount}</span>
          </button>
          <button className={'tab' + (tab === 'attachments' ? ' active' : '')} onClick={() => setTab('attachments')}>
            Attachments <span className="badge">{attCount}</span>
          </button>
          <button className={'tab' + (tab === 'related' ? ' active' : '')} onClick={() => setTab('related')}>
            Related
          </button>
        </div>
        {tab === 'journal'     && <JournalTab     entries={journals} />}
        {tab === 'audit'       && <AuditTab       entries={audits} table={table} />}
        {tab === 'attachments' && <AttachmentsTab entries={atts} />}
        {tab === 'related'     && <RelatedTab     rec={rec} table={table} journals={journals} />}
      </div>
    </div>
  );
};

function _LoadingTab({ label }) {
  return (
    <div className="empty">
      <div className="dot-pulse" style={{ marginBottom: 12 }} />
      <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>{label}</span>
    </div>
  );
}

function RecordHeader({ rec, table }) {
  const stDec = window.decodeChoice(table === 'change_request' ? 'change_request' : 'incident', 'state', rec.state);
  const stCls = window.stateChipClass(table, rec.state);
  const isChange = window.CHANGE_STYLE_TABLES.has(table);
  return (
    <div className="record-header">
      <div className="crumbs">
        <a onClick={() => window.navigate(window.listUrl(table))}>{window.taskLabel(table, 'plural')}</a>
        <window.Icon name="chevron_right" size={11} />
        <span className="mono">{rec.number}</span>
      </div>
      <h1>
        <span className="num">{rec.number}</span>
        <span style={{ flex: 1, minWidth: 0 }}>{rec.short_description}</span>
      </h1>
      <div className="title-row">
        <span className={`chip ${stCls}`}>{stDec.label || rec.state || '—'}</span>
        {!isChange && rec.priority && (() => {
          const prDec = window.decodeChoice('incident', 'priority', rec.priority);
          const bars = window.priorityBars(rec.priority);
          return (
            <span className={`chip ${window.priorityChipClass(rec.priority)}`}>
              <span className={`priority-bar ${bars.cls}`}>
                {[0,1,2,3,4].map(i => <span key={i} className={'b' + (i < bars.filled ? ' on' : '')} style={{ height: 4 + i * 2 }} />)}
              </span>
              {prDec.label}
            </span>
          );
        })()}
        {isChange && rec.type && <span className={`chip ${rec.type === 'emergency' ? 'red' : rec.type === 'normal' ? 'amber' : 'green'}`}>{rec.type}</span>}
        {rec.legal_hold && <span className="chip amber"><window.Icon name="lock" size={10} /> legal hold</span>}
        <span className="dot">·</span>
        <span>opened {window.fmtRelative(rec.opened_at || rec.sys_created_on)}</span>
        <span className="dot">·</span>
        <span>updated {window.fmtRelative(rec.sys_updated_on)}</span>
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--fg-4)' }}>
          sys_id {rec.sys_id.slice(0, 8)}…
        </span>
      </div>
    </div>
  );
}

function Field({ label, children, raw, showRaw }) {
  return (
    <>
      <div className="label">{label}</div>
      <div className="value">
        {children}
        {showRaw && raw != null && raw !== '' && <span className="raw">{String(raw)}</span>}
      </div>
    </>
  );
}

function RefLink({ kind, sys_id, fallback }) {
  if (!sys_id) return <span style={{ color: 'var(--fg-4)', fontStyle: 'italic' }}>—</span>;
  // `fallback` is typically the __display_<field> from the record envelope:
  // ServiceNow's display_value at export time. We use it whenever the local
  // lookup map doesn't have the sys_id (e.g. user deactivated and not exported).
  const renderUnresolved = () => (
    <span className="ref-link" title={`Reference (sys_id ${sys_id.slice(0, 8)}…) not in lookup`}>
      {fallback || sys_id.slice(0, 8) + '…'}
    </span>
  );
  if (kind === 'user') {
    const u = window.findUser(sys_id);
    if (!u) return renderUnresolved();
    return <span className="ref-link" onClick={() => window.navigate(`/users/${sys_id}`)}>{u.name || fallback || sys_id.slice(0, 8) + '…'}</span>;
  }
  if (kind === 'group') {
    const g = window.findGroup(sys_id);
    if (!g) return renderUnresolved();
    return <span className="ref-link" onClick={() => window.navigate(`/groups/${sys_id}`)}>{g.name || fallback}</span>;
  }
  if (kind === 'ci') {
    const c = window.findCI(sys_id);
    if (!c) return renderUnresolved();
    return <span className="ref-link" onClick={() => window.navigate(`/cis/${sys_id}`)}>{c.name || fallback}</span>;
  }
  return <span>{fallback || ''}</span>;
}

function FieldsSection({ rec, table, showRaw }) {
  const isChange = window.CHANGE_STYLE_TABLES.has(table);
  return (
    <>
      <div className="section">
        <h3>Description</h3>
        <div className="kv-block">{rec.description || '—'}</div>
      </div>
      <div className="section">
        <h3>Identification</h3>
        <div className="fields">
          <Field label="Number" showRaw={showRaw} raw={rec.number}><span className="mono">{rec.number}</span></Field>
          <Field label="sys_id" showRaw={false}><span className="mono" style={{ color: 'var(--fg-3)', fontSize: 12 }}>{rec.sys_id}</span></Field>
          <Field label="Company" showRaw={showRaw} raw={rec.company}>{window.findCompany(rec.company)?.name || '—'}</Field>
          {!isChange && rec.caller_id !== undefined && <Field label="Caller" showRaw={showRaw} raw={rec.caller_id}><RefLink kind="user" sys_id={rec.caller_id} fallback={rec.__display_caller_id} /></Field>}
          {!isChange && rec.opened_by !== undefined && <Field label="Opened by" showRaw={showRaw} raw={rec.opened_by}><RefLink kind="user" sys_id={rec.opened_by} fallback={rec.__display_opened_by} /></Field>}
          {isChange && <Field label="Requested by" showRaw={showRaw} raw={rec.requested_by}><RefLink kind="user" sys_id={rec.requested_by} fallback={rec.__display_requested_by} /></Field>}
          <Field label="Assigned to" showRaw={showRaw} raw={rec.assigned_to}><RefLink kind="user" sys_id={rec.assigned_to} fallback={rec.__display_assigned_to} /></Field>
          <Field label="Assignment group" showRaw={showRaw} raw={rec.assignment_group}><RefLink kind="group" sys_id={rec.assignment_group} fallback={rec.__display_assignment_group} /></Field>
          <Field label="Configuration item" showRaw={showRaw} raw={rec.cmdb_ci}><RefLink kind="ci" sys_id={rec.cmdb_ci} fallback={rec.__display_cmdb_ci} /></Field>
        </div>
      </div>
      {!isChange && (
        <div className="section">
          <h3>Classification</h3>
          <div className="fields">
            {(() => {
              const pr = window.decodeChoice('incident', 'priority', rec.priority);
              const im = window.decodeChoice('incident', 'priority', rec.impact);
              const ur = window.decodeChoice('incident', 'priority', rec.urgency);
              const st = window.decodeChoice('incident', 'state', rec.state);
              return <>
                <Field label="Priority" showRaw={showRaw} raw={pr.value}>{pr.label || rec.priority || '—'}</Field>
                <Field label="Impact" showRaw={showRaw} raw={im.value}>{im.label || rec.impact || '—'}</Field>
                <Field label="Urgency" showRaw={showRaw} raw={ur.value}>{ur.label || rec.urgency || '—'}</Field>
                <Field label="State" showRaw={showRaw} raw={st.value}>{st.label || rec.state || '—'}</Field>
                <Field label="Category" showRaw={showRaw} raw={rec.category}>{rec.category || '—'}</Field>
                <Field label="Contact type" showRaw={showRaw} raw={rec.contact_type}>{rec.contact_type || '—'}</Field>
              </>;
            })()}
          </div>
        </div>
      )}
      {isChange && (
        <div className="section">
          <h3>Change attributes</h3>
          <div className="fields">
            <Field label="Type" showRaw={showRaw} raw={rec.type}>{rec.type}</Field>
            <Field label="Risk" showRaw={showRaw} raw={rec.risk}>{rec.risk}</Field>
            <Field label="Impact" showRaw={showRaw} raw={rec.impact}>{rec.impact}</Field>
            <Field label="State" showRaw={showRaw} raw={rec.state}>{window.decodeChoice('change_request', 'state', rec.state).label}</Field>
            <Field label="Start date" showRaw={false}>{window.fmtDate(rec.start_date)}</Field>
            <Field label="End date" showRaw={false}>{window.fmtDate(rec.end_date)}</Field>
          </div>
        </div>
      )}
      <div className="section">
        <h3>Resolution</h3>
        <div className="fields">
          <Field label="Opened at" showRaw={false}>{window.fmtDate(rec.opened_at || rec.sys_created_on)}</Field>
          <Field label="Resolved at" showRaw={false}>{rec.resolved_at ? window.fmtDate(rec.resolved_at) : <span style={{ color: 'var(--fg-4)' }}>—</span>}</Field>
          <Field label="Closed at" showRaw={false}>{rec.closed_at ? window.fmtDate(rec.closed_at) : <span style={{ color: 'var(--fg-4)' }}>—</span>}</Field>
          {rec.close_code && (() => {
            const cc = window.decodeChoice('incident', 'close_code', rec.close_code);
            return <Field label="Close code" showRaw={showRaw} raw={cc.value}>{cc.label}</Field>;
          })()}
          {rec.close_notes && (
            <>
              <div className="label">Close notes</div>
              <div className="value"><div className="kv-block" style={{ width: '100%' }}>{rec.close_notes}</div></div>
            </>
          )}
          <Field label="Legal hold" showRaw={showRaw} raw={String(rec.legal_hold)}>{rec.legal_hold ? <span className="chip amber"><window.Icon name="lock" size={10} /> true</span> : 'false'}</Field>
        </div>
      </div>
    </>
  );
}

function TasksSection({ tasks, table }) {
  const childTable = CHILD_REL[table]?.table;
  const heading = childTable ? window.taskLabel(childTable, 'plural') : 'Child tasks';
  return (
    <div className="section">
      <h3>{heading} <span className="count">{tasks.length}</span></h3>
      <div className="related-list" style={{ padding: 0, marginBottom: 12 }}>
        {tasks.map(t => (
          <div key={t.sys_id} className="related-item"
               onClick={() => childTable && window.navigate(window.recordUrl(childTable, t.sys_id))}>
            <span className="num">{t.number}</span>
            <span className="desc">{t.short_description}</span>
            <span className="chip green">closed</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Catalog variables — render the form fields a user typed when submitting
// an RITM. Variable definitions vary per catalog item (sc_cat_item), so
// we drive the layout off the joined item_option_new rows and don't try
// to be clever about types beyond a few known cases:
//   1=string, 2=text, 5=select, 6=multi-line, 7=reference, 8=checkbox,
//   9=date, 17=tree picker, 21=email, 22=URL, 24=lookup, 26=lookup select.
function VariablesSection({ rows, cat_item }) {
  if (!rows || rows.length === 0) return null;
  const renderValue = (v, type, reference) => {
    const val = v == null || v === '' ? '—' : String(v);
    if (val === '—') return <span style={{ color: 'var(--fg-4)', fontStyle: 'italic' }}>—</span>;
    const typeNum = parseInt(type, 10);
    // Reference variable → try to resolve via lookup maps. The `reference`
    // column tells us which table the sys_id points at.
    if ((typeNum === 7 || typeNum === 24 || typeNum === 26) && /^[a-f0-9]{32}$/.test(val)) {
      if (reference === 'sys_user') {
        return <window.UserCell sys_id={val} />;
      }
      if (reference === 'sys_user_group') {
        const g = window.findGroup(val);
        return g ? <span className="ref-link" onClick={() => window.navigate(`/groups/${val}`)}>{g.name}</span>
                 : <span className="mono" style={{ fontSize: 11.5 }}>{val.slice(0, 8)}…</span>;
      }
      if (reference === 'cmdb_ci') {
        const c = window.findCI(val);
        return c ? <span className="ref-link" onClick={() => window.navigate(`/cis/${val}`)}>{c.name}</span>
                 : <span className="mono" style={{ fontSize: 11.5 }}>{val.slice(0, 8)}…</span>;
      }
      // Unknown reference table — just show the sys_id.
      return <span className="mono" style={{ fontSize: 11.5 }}>{val.slice(0, 8)}…</span>;
    }
    // Checkbox: ServiceNow stores 'true'/'false'.
    if (typeNum === 8) {
      return <span>{(val === 'true' || val === '1') ? 'Yes' : 'No'}</span>;
    }
    // Multi-line / long text — preserve newlines.
    if (typeNum === 2 || typeNum === 6) {
      return <span style={{ whiteSpace: 'pre-wrap' }}>{val}</span>;
    }
    return <span>{val}</span>;
  };
  return (
    <div className="section">
      <h3>
        Variables
        <span className="count">{rows.length}</span>
        {cat_item && <span style={{
          marginLeft: 10, fontSize: 11.5, color: 'var(--fg-3)',
          fontWeight: 400, fontFamily: 'var(--font-mono)',
        }}>{cat_item}</span>}
      </h3>
      <div className="kv-block" style={{
        display: 'grid', gridTemplateColumns: '180px 1fr', rowGap: 6, columnGap: 14,
        padding: '10px 12px',
      }}>
        {rows.map(v => (
          <React.Fragment key={v.opt_sys_id || v.def_sys_id || v.var_name}>
            <div style={{ color: 'var(--fg-3)', fontSize: 12 }}>
              {v.label || v.var_name || '(unnamed)'}
            </div>
            <div style={{ fontSize: 12.5 }}>
              {renderValue(v.value, v.type, v.reference)}
            </div>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function SLAsSection({ slas }) {
  return (
    <div className="section">
      <h3>SLAs <span className="count">{slas.length}</span></h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingBottom: 14 }}>
        {slas.map(s => {
          const pct = parseInt(s.business_percentage, 10);
          return (
            <div key={s.sys_id} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 60px', gap: 10, alignItems: 'center', fontSize: 12.5 }}>
              <span>{s.sla_definition}</span>
              <div style={{ height: 6, background: 'var(--bg-3)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: pct + '%', background: pct > 80 ? 'var(--accent)' : pct > 50 ? 'var(--c-amber)' : 'var(--c-red)' }} />
              </div>
              <span className="mono" style={{ color: 'var(--fg-3)', fontSize: 11.5, textAlign: 'right' }}>{s.business_percentage}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AffectedCIsSection({ ciLinks }) {
  return (
    <div className="section">
      <h3>Affected CIs <span className="count">{ciLinks.length}</span></h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingBottom: 14 }}>
        {ciLinks.map(l => {
          const ci = window.findCI(l.ci);
          return (
            <div key={l.sys_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-elev)', cursor: 'pointer' }}
                 onClick={() => window.navigate(`/cis/${ci.sys_id}`)}>
              <window.Icon name="ci" size={12} />
              <span className="mono" style={{ fontSize: 12.5 }}>{ci?.name}</span>
              <span className="muted" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{ci?.sys_class_name}</span>
              <span style={{ marginLeft: 'auto' }}>
                <span className={`chip ${ci?.operational_status === 'Operational' ? 'green' : ci?.operational_status === 'Degraded' ? 'amber' : 'red'}`}>{ci?.operational_status}</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ApprovalsSection({ approvals }) {
  return (
    <div className="section">
      <h3>Approvals <span className="count">{approvals.length}</span></h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingBottom: 14 }}>
        {approvals.map(a => (
          <div key={a.sys_id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-elev)' }}>
            <window.UserCell sys_id={a.approver} displayName={a.__display_approver} />
            <span style={{ marginLeft: 'auto' }}>
              <span className={`chip ${a.state === 'approved' ? 'green' : 'amber'}`}>{a.state}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ManifestFooter({ rec }) {
  const m = window.HistoricalWowData?.manifest || {};
  const tag = [m.snapshot_date, m.label].filter(Boolean).join(' ') || 'unlabeled snapshot';
  return (
    <div className="section" style={{ borderBottom: 'none', color: 'var(--fg-4)', fontSize: 11.5, paddingTop: 14, paddingBottom: 30 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)' }}>
        <window.Icon name="archive" size={11} />
        <span>archived from snapshot {tag}</span>
        <span style={{ marginLeft: 'auto' }}>sha256 {rec.sys_id.slice(8, 24)}</span>
      </div>
    </div>
  );
}

// ----- Tabs -----
function JournalTab({ entries }) {
  if (entries == null) return <_LoadingTab label="loading journal…" />;
  if (!entries.length) {
    return <div className="empty"><div className="glyph"><window.Icon name="book" /></div>No journal entries.</div>;
  }
  // Lookup user by username (sys_created_by) since the journal record may not
  // have a sys_id-resolved field server-side.
  const userByUsername = new Map();
  for (const u of window.HistoricalWowData.sys_user) {
    if (u.user_name) userByUsername.set(u.user_name, u);
  }
  return (
    <div className="journal">
      {entries.map(e => {
        const u = window.findUser(e.sys_created_by_sys_id) ||
                  userByUsername.get(e.sys_created_by);
        return (
          <div key={e.sys_id} className="entry">
            <div><window.Avatar name={u?.name || e.sys_created_by} /></div>
            <div>
              <div className="head">
                <span className="who">{u?.name || e.sys_created_by}</span>
                <span className={`kind ${e.element}`}>{e.element === 'work_notes' ? 'work notes' : 'comment'}</span>
                <span className="when" title={e.sys_created_on}>{window.fmtRelative(e.sys_created_on)} · {e.sys_created_on}</span>
              </div>
              <div className="body">{e.value}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AuditTab({ entries, table }) {
  if (entries == null) return <_LoadingTab label="loading history…" />;
  if (!entries.length) {
    return <div className="empty"><div className="glyph"><window.Icon name="history" /></div>No audit entries.</div>;
  }
  const renderVal = (a, val) => {
    if (val == null || val === '') return <span style={{ color: 'var(--fg-4)' }}>—</span>;
    if (a.fieldname === 'state') return window.decodeChoice(table, 'state', val).label;
    if (a.fieldname === 'priority') return window.decodeChoice('incident', 'priority', val).label;
    if (a.fieldname === 'close_code') return window.decodeChoice('incident', 'close_code', val).label;
    if (a.fieldname === 'assigned_to' || a.fieldname === 'caller_id') {
      const u = window.findUser(val);
      return u ? u.name : <span className="mono" style={{ fontSize: 11.5 }}>{val.slice(0, 12)}…</span>;
    }
    if (a.fieldname === 'assignment_group') {
      const g = window.findGroup(val);
      return g ? g.name : val;
    }
    return String(val);
  };
  return (
    <div className="audit">
      {entries.map(a => (
        <div key={a.sys_id} className="audit-row">
          <span className="when">{a.sys_created_on}</span>
          <span className="field">{a.fieldlabel}<span className="label">{a.fieldname}</span></span>
          <span className="from">{renderVal(a, a.oldvalue)}</span>
          <span className="to"><span className="arrow">→</span>{renderVal(a, a.newvalue)} <span style={{ color: 'var(--fg-4)', fontSize: 11.5, marginLeft: 8 }}>by {a.user}</span></span>
        </div>
      ))}
    </div>
  );
}

function AttachmentsTab({ entries }) {
  if (entries == null) return <_LoadingTab label="loading attachments…" />;
  if (!entries.length) {
    return <div className="empty"><div className="glyph"><window.Icon name="paperclip" /></div>No attachments.</div>;
  }
  const ext = (n) => ((n || '').split('.').pop() || '').toUpperCase().slice(0, 4);
  // Mirror the exporter's _safe_name(): replace anything outside [A-Za-z0-9._-]
  // with '_', cap at 200 chars. Falls back to 'file' for empty input.
  const safeFilename = (n) => {
    if (!n) return 'file';
    const s = n.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
    return s || 'file';
  };
  // Mirror the exporter's two-char hex sharding (first 2 chars of sys_id).
  const shard = (sid) => (sid?.slice(0, 2) || '__').toLowerCase();
  return (
    <div className="attachments-list">
      {entries.map(a => (
        <div key={a.sys_id} className="attachment">
          <div className="icon">{ext(a.file_name)}</div>
          <div className="meta">
            <div className="name">{a.file_name}</div>
            <div className="sub">{window.fmtBytes(a.size_bytes)} · {a.content_type} · uploaded {window.fmtRelative(a.sys_created_on)} by {a.sys_created_by}</div>
          </div>
          <a className="download"
             href={`data/attachments/${shard(a.sys_id)}/${a.sys_id}/${safeFilename(a.file_name)}`}
             download={a.file_name || 'file'}
             title="Download from archive"
             onClick={(e) => e.stopPropagation()}>
            <window.Icon name="download" size={14} />
          </a>
        </div>
      ))}
    </div>
  );
}

function RelatedTab(props) {
  const { rec, table } = props;
  const data = window.HistoricalWowData;
  // Other records on the same CI — search across every loaded task table,
  // not just incidents, since a CI is referenced from any task type.
  let items = [];
  if (rec.cmdb_ci) {
    const buckets = window.TASK_TABLES || ['incident', 'change_request'];
    for (const t of buckets) {
      const arr = window.getTaskRecords(t);
      for (const r of arr) {
        if (r.cmdb_ci === rec.cmdb_ci && r.sys_id !== rec.sys_id) {
          items.push({ rec: r, table: t });
          if (items.length >= 8) break;
        }
      }
      if (items.length >= 8) break;
    }
  }
  // Journal mentions: any of ServiceNow's standard prefixes for a task or KB.
  // `journals` is passed in by RecordPage (already fetched via API). Null
  // while loading; treat as empty until then.
  const allJournals = props.journals || [];
  const refs = new Set();
  for (const j of allJournals) {
    const m = (j.value || '').match(/(INC\d+|CHG\d+|PRB\d+|RITM\d+|REQ\d+|SCTASK\d+|TASK\d+|KB\d+)/g);
    if (m) m.forEach(x => refs.add(x));
  }
  // Resolve each reference against any loaded task table.
  const findByNumber = (num) => {
    const tables = window.TASK_TABLES || ['incident', 'change_request'];
    for (const t of tables) {
      const arr = window.getTaskRecords(t);
      const hit = arr.find(r => r.number === num);
      if (hit) return { rec: hit, table: t };
    }
    return null;
  };
  return (
    <div className="related-list">
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--fg-3)', margin: '4px 0 8px' }}>Same CI · {items.length}</div>
      {items.length === 0 && <div style={{ color: 'var(--fg-4)', fontSize: 12.5, padding: '6px 0' }}>No other records on this CI in snapshot.</div>}
      {items.map(({ rec: i, table: t }) => (
        <div key={i.sys_id} className="related-item" onClick={() => window.navigate(window.recordUrl(t, i.sys_id))}>
          <span className="num">{i.number}</span>
          <span className="desc">{i.short_description}</span>
          <span className={`chip ${window.stateChipClass('incident', i.state)}`}>{window.decodeChoice('incident', 'state', i.state).label || i.state}</span>
        </div>
      ))}
      {refs.size > 0 && (
        <>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--fg-3)', margin: '16px 0 8px' }}>Mentioned in journal · {refs.size}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {[...refs].map(r => {
              const found = findByNumber(r);
              const target = found?.rec;
              const targetTable = found?.table;
              return (
                <span key={r} className="chip" style={{ cursor: target ? 'pointer' : 'default' }}
                  onClick={() => target && window.navigate(window.recordUrl(targetTable, target.sys_id))}>
                  <window.Icon name="link" size={10} />
                  {r}{!target && <span style={{ color: 'var(--fg-4)' }}> · not loaded</span>}
                </span>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
