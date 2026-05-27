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

const ASSET_TABLES_SET = new Set([
  'alm_asset', 'alm_hardware', 'alm_software_license',
  'alm_consumable', 'alm_facility', 'alm_stockroom',
  'sn_ent_facility_asset',
]);

window.RecordPage = function RecordPage({ table, sys_id, showRaw }) {
  const data = window.HistoricalWowData;
  const [tab, setTab] = React.useState('journal');
  // All record data fetched via API on mount. No eager-loaded incident list,
  // so we don't have a "slim" until the API responds.
  const [fullRec, setFullRec]   = React.useState(null);
  const [journals, setJournals] = React.useState(null);
  const [audits, setAudits]     = React.useState(null);
  const [atts, setAtts]         = React.useState(null);
  const [emails, setEmails]     = React.useState(null);
  const [tasks, setTasks]       = React.useState([]);
  const [ciLinks, setCILinks]   = React.useState([]);
  const [slas, setSLAs]         = React.useState([]);
  const [approvals, setApprovals] = React.useState([]);
  const [variables, setVariables] = React.useState({ rows: [], cat_item: null });
  const [assetCITickets, setAssetCITickets] = React.useState(null); // tickets that reference this asset's linked CI
  const [groupApprovals, setGroupApprovals] = React.useState(null); // sysapproval_group rows under this parent
  const isAsset = ASSET_TABLES_SET.has(table);
  const isGroupApproval = table === 'sysapproval_group';

  React.useEffect(() => {
    let cancel = false;
    setFullRec(null); setJournals(null); setAudits(null); setAtts(null);
    setTasks([]); setCILinks([]); setSLAs([]); setApprovals([]);
    setVariables({ rows: [], cat_item: null });
    setAssetCITickets(null);
    setGroupApprovals(null);

    data.fetchRecord(table, sys_id).then(r => {
      if (cancel) return;
      setFullRec(r);
      if (r) {
        const audit_label = r.short_description || r.display_name || r.name || '';
        const audit_target = r.number || r.asset_tag || sys_id.slice(0, 8);
        window.AuditLog.push('view', `${table}/${audit_target}`, audit_label);
      }
      // Asset → CI → tickets: when viewing a hardware/asset, also pull the
      // tickets that reference the linked CI so the user gets the implicit
      // "what tickets touched this laptop" view in one place.
      if (r && isAsset && r.ci) {
        Promise.all([
          data.fetchTaskList('incident',       { filters: { cmdb_ci: r.ci }, limit: 25, slim: 1, order_by: 'sys_updated_on', dir: 'desc' }).catch(() => ({ rows: [] })),
          data.fetchTaskList('change_request', { filters: { cmdb_ci: r.ci }, limit: 25, slim: 1, order_by: 'sys_updated_on', dir: 'desc' }).catch(() => ({ rows: [] })),
          data.fetchTaskList('problem',        { filters: { cmdb_ci: r.ci }, limit: 25, slim: 1, order_by: 'sys_updated_on', dir: 'desc' }).catch(() => ({ rows: [] })),
        ]).then(([inc, chg, prb]) => {
          if (cancel) return;
          const merged = [
            ...(inc.rows || []).map(x => ({ ...x, _table: 'incident' })),
            ...(chg.rows || []).map(x => ({ ...x, _table: 'change_request' })),
            ...(prb.rows || []).map(x => ({ ...x, _table: 'problem' })),
          ].sort((a, b) => (b.sys_updated_on || '').localeCompare(a.sys_updated_on || ''));
          setAssetCITickets(merged);
        });
      } else if (cancel || !r || !isAsset) {
        // leave assetCITickets null so we just hide the section
      }
      // sysapproval_group needs its parent + group sys_ids to find the
      // spawned approvers (they point at parent, not at the group record).
      if (r && isGroupApproval) {
        const grp = r.assignment_group || r.group;
        const filters = grp ? { sysapproval: r.parent, group: grp } : { sysapproval: r.parent };
        if (r.parent) {
          data.fetchTaskList('sysapproval_approver', { filters, limit: 100 })
            .then(res => { if (!cancel) setApprovals(res.rows || []); }).catch(() => {});
        }
      }
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
    // Emails tied to this record (sys_email.instance == sys_id). Metadata-only
    // by design; HR-gated at the API. Keep total to flag truncation.
    data.fetchTaskList('sys_email', { filters: { instance: sys_id }, order_by: 'sys_created_on', dir: 'desc', limit: 200, slim: 1 })
      .then(r => { if (!cancel) setEmails(r); }).catch(() => { if (!cancel) setEmails({ rows: [], total: 0 }); });

    // Per-record relationships (each is a small filtered query — was eager-
    // loaded as 422k+90k+75k rows, now 0–N rows per record). Asset records
    // skip these — they don't have parent/task_ci/sla/approver relations.
    if (!isAsset) {
      const rel = CHILD_REL[table];
      if (rel) {
        data.fetchTaskList(rel.table, { filters: { [rel.field]: sys_id }, limit: 200, slim: 1 })
          .then(r => { if (!cancel) setTasks(r.rows || []); }).catch(() => {});
      }
      data.fetchTaskList('task_ci', { filters: { task: sys_id }, limit: 200 })
        .then(r => { if (!cancel) setCILinks(r.rows || []); }).catch(() => {});
      data.fetchTaskList('task_sla', { filters: { task: sys_id }, limit: 50 })
        .then(r => { if (!cancel) setSLAs(r.rows || []); }).catch(() => {});
      // sysapproval_approver normally points to the parent task via
      // `sysapproval`. For a sysapproval_group record we'd usually find
      // zero direct matches; the dedicated isGroupApproval block below
      // handles those by filtering on parent+group instead — skip the
      // direct lookup here so we don't race with it (first call returns
      // [] before the second resolves).
      if (!isGroupApproval) {
        data.fetchTaskList('sysapproval_approver', { filters: { sysapproval: sys_id }, limit: 50 })
          .then(r => { if (!cancel) setApprovals(r.rows || []); }).catch(() => {});
      }
      if (table === 'sc_req_item') {
        data.fetchVariables(sys_id)
          .then(r => { if (!cancel) setVariables(r); }).catch(() => {});
      }
      // Group approvals routed for this parent task. Only meaningful for
      // tables that actually receive approvals (change_request,
      // sc_request, sc_req_item) — but querying for everything else
      // returns 0 cheaply, so don't bother gating.
      if (!isGroupApproval) {
        data.fetchTaskList('sysapproval_group', { filters: { parent: sys_id }, limit: 25, slim: 1 })
          .then(r => { if (!cancel) setGroupApprovals(r.rows || []); }).catch(() => {});
      }
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
  const emailCount   = emails    == null ? '…' : emails.total;

  return (
    <div className="record">
      <div className="left">
        {isAsset
          ? <AssetRecordHeader rec={rec} table={table} />
          : <RecordHeader rec={rec} table={table} />}
        {isAsset
          ? <AssetFieldsSection rec={rec} table={table} showRaw={showRaw} />
          : <FieldsSection rec={rec} table={table} showRaw={showRaw} />}
        {isAsset && assetCITickets && assetCITickets.length > 0 && (
          <AssetCITicketsSection rows={assetCITickets} ci={rec.ci} ci_display={rec.__display_ci} />
        )}
        <VariablesSection rows={variables.rows} cat_item={variables.cat_item} />
        {isGroupApproval && (
          <GroupApprovalContextSection rec={rec} />
        )}
        {tasks.length > 0 && <TasksSection tasks={tasks} table={table} />}
        {slas.length > 0 && <SLAsSection slas={slas} />}
        {ciLinks.length > 0 && <AffectedCIsSection ciLinks={ciLinks} />}
        {approvals.length > 0 && <ApprovalsSection approvals={approvals} />}
        {groupApprovals && groupApprovals.length > 0 && (
          <GroupApprovalsSection rows={groupApprovals} />
        )}
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
          <button className={'tab' + (tab === 'emails' ? ' active' : '')} onClick={() => setTab('emails')}>
            Emails <span className="badge">{emailCount}</span>
          </button>
          <button className={'tab' + (tab === 'related' ? ' active' : '')} onClick={() => setTab('related')}>
            Related
          </button>
        </div>
        {tab === 'journal'     && <JournalTab     entries={journals} />}
        {tab === 'audit'       && <AuditTab       entries={audits} table={table} />}
        {tab === 'attachments' && <AttachmentsTab entries={atts} />}
        {tab === 'emails'      && <EmailsTab      resp={emails} />}
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

// ---- Group approvals -----------------------------------------------------
// Maps a record number prefix (CHG / RITM / REQ / INC / PRB) to the
// task table that owns it. Used to navigate from a sysapproval_group
// up to the parent task without having to query every candidate table —
// ServiceNow's own number prefixes carry the type in the leading
// alphabetic chars.
const NUMBER_PREFIX_TABLE = {
  INC:    'incident',
  CHG:    'change_request',
  PRB:    'problem',
  PTASK:  'problem_task',
  CTASK:  'change_task',
  ITASK:  'incident_task',
  REQ:    'sc_request',
  RITM:   'sc_req_item',
  SCTASK: 'sc_task',
  ATASK:  'asset_task',
};

function tableFromNumber(num) {
  if (!num) return null;
  const m = String(num).match(/^([A-Z]+)\d/);
  return m ? NUMBER_PREFIX_TABLE[m[1]] : null;
}

function ParentTaskLink({ parent_sys_id, parent_display, fallback_label }) {
  if (!parent_sys_id) {
    return <span style={{ color: 'var(--fg-4)', fontStyle: 'italic' }}>{fallback_label || '—'}</span>;
  }
  const tbl = tableFromNumber(parent_display);
  const url = tbl ? window.recordUrl(tbl, parent_sys_id) : `/tasks/${tbl || 'task'}/${parent_sys_id}`;
  return (
    <span className="ref-link" onClick={() => window.navigate(url)}>
      <span className="mono" style={{ marginRight: 4 }}>{parent_display || sys_id_short(parent_sys_id)}</span>
      {tbl && <span style={{ color: 'var(--fg-4)', fontSize: 11.5 }}>· {window.taskLabel(tbl, 'singular')}</span>}
    </span>
  );
}

function stateChipColor(state) {
  // sysapproval_group / approver state values are mostly: requested,
  // approved, rejected, cancelled, no_longer_required, duplicate.
  const s = (state || '').toLowerCase();
  if (s === 'approved') return 'green';
  if (s === 'rejected') return 'red';
  if (s === 'cancelled' || s === 'no_longer_required' || s === 'duplicate') return 'gray';
  return 'amber'; // requested / pending / etc.
}

// On a parent task page, list the group-level approval records routed
// for it (one card per `sysapproval_group` whose `parent` = this).
function GroupApprovalsSection({ rows }) {
  return (
    <div className="section">
      <h3>Group approvals <span className="count">{rows.length}</span></h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingBottom: 14 }}>
        {rows.map(g => {
          const grp = g.assignment_group;
          const grpDisplay = g.__display_assignment_group || (grp && window.findGroup(grp)?.name) || sys_id_short(grp);
          return (
            <div key={g.sys_id}
                 onClick={() => window.navigate(window.recordUrl('sysapproval_group', g.sys_id))}
                 style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
                          border: '1px solid var(--border)', borderRadius: 6,
                          background: 'var(--bg-elev)', cursor: 'pointer' }}>
              <window.Icon name="users" size={12} />
              <span>{grpDisplay}</span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className={`chip ${stateChipColor(g.state)}`}>{g.__display_state || g.state || '—'}</span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--fg-4)' }}>{g.number || g.sys_id.slice(0, 8) + '…'}</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// On a sysapproval_group page, surface what we're approving (parent task
// link) and which group it was routed to. The existing ApprovalsSection
// already shows individual approver decisions once we've loaded them.
function GroupApprovalContextSection({ rec }) {
  const grp = rec.assignment_group || rec.group;
  const grpDisplay = rec.__display_assignment_group || rec.__display_group ||
                     (grp && window.findGroup(grp)?.name) || sys_id_short(grp);
  return (
    <div className="section">
      <h3>Approval context</h3>
      <div className="fields">
        <Field label="Approving" showRaw={false}>
          <ParentTaskLink
            parent_sys_id={rec.parent}
            parent_display={rec.__display_parent}
            fallback_label="(no parent)"
          />
        </Field>
        <Field label="Routed to group" showRaw={false}>
          {grp
            ? <RefLink kind="group" sys_id={grp} fallback={grpDisplay} />
            : <span style={{ color: 'var(--fg-4)', fontStyle: 'italic' }}>—</span>}
        </Field>
        <Field label="Approval state" showRaw={false}>
          <span className={`chip ${stateChipColor(rec.state)}`}>
            {rec.__display_state || rec.state || '—'}
          </span>
        </Field>
        <Field label="Requested by" showRaw={false}>
          {rec.requested_by
            ? <RefLink kind="user" sys_id={rec.requested_by} fallback={rec.__display_requested_by} />
            : <span style={{ color: 'var(--fg-4)', fontStyle: 'italic' }}>—</span>}
        </Field>
      </div>
      {rec.comments && (
        <div className="kv-block" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>
          {rec.comments}
        </div>
      )}
    </div>
  );
}

// ---- Asset record header / fields / related tickets ---------------------

function AssetRecordHeader({ rec, table }) {
  const subclass = rec.sys_class_name || table;
  const statusDec = window.decodeChoice('alm_asset', 'install_status', rec.state || rec.install_status);
  const statusLabel = statusDec.label || rec.__display_install_status || rec.state || '—';
  const title = rec.display_name || rec.name || rec.asset_tag || sys_id_short(rec.sys_id);
  return (
    <div className="record-header">
      <div className="crumbs">
        <a onClick={() => window.navigate(window.listUrl(table))}>{window.taskLabel(table, 'plural')}</a>
        <window.Icon name="chevron_right" size={11} />
        <span className="mono">{rec.asset_tag || rec.sys_id.slice(0, 8) + '…'}</span>
      </div>
      <h1>
        <span className="num">{rec.asset_tag || ''}</span>
        <span style={{ flex: 1, minWidth: 0 }}>{title}</span>
      </h1>
      <div className="title-row">
        <span className="chip">{statusLabel}</span>
        {subclass && subclass !== table && (
          <span className="chip" style={{ fontFamily: 'var(--font-mono)' }}>{subclass}</span>
        )}
        <span className="dot">·</span>
        <span>created {window.fmtRelative(rec.sys_created_on)}</span>
        <span className="dot">·</span>
        <span>updated {window.fmtRelative(rec.sys_updated_on)}</span>
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--fg-4)' }}>
          sys_id {rec.sys_id.slice(0, 8)}…
        </span>
      </div>
    </div>
  );
}

function sys_id_short(s) { return s ? s.slice(0, 8) + '…' : '—'; }

// Render any sys_id-shaped reference field with a sensible link target
// based on the field's name and the ServiceNow `__display_<field>`
// envelope value. Falls back to the plain display value (or the sys_id
// short form) when the target table isn't one we render.
function AssetRef({ rec, field, kind, fallback }) {
  const v = rec[field];
  const display = fallback || rec['__display_' + field];
  if (!v) return <span style={{ color: 'var(--fg-4)', fontStyle: 'italic' }}>—</span>;
  if (kind === 'user') return <RefLink kind="user" sys_id={v} fallback={display} />;
  if (kind === 'group') return <RefLink kind="group" sys_id={v} fallback={display} />;
  if (kind === 'ci') return <RefLink kind="ci" sys_id={v} fallback={display} />;
  if (kind === 'company') {
    const c = window.findCompany?.(v);
    return c ? <span>{c.name}</span> : <span>{display || sys_id_short(v)}</span>;
  }
  if (kind === 'department') {
    const d = window.findDepartment?.(v);
    return d ? <span>{d.name}</span> : <span>{display || sys_id_short(v)}</span>;
  }
  if (kind === 'location') {
    const l = window.findLocation?.(v);
    return l ? <span>{l.name}</span> : <span>{display || sys_id_short(v)}</span>;
  }
  if (kind === 'cost_center') {
    const cc = window.HistoricalWowData.cost_centers.find(c => c.sys_id === v);
    return cc ? <span>{cc.name || cc.code}</span> : <span>{display || sys_id_short(v)}</span>;
  }
  return <span>{display || sys_id_short(v)}</span>;
}

function AssetFieldsSection({ rec, table, showRaw }) {
  // Per-table custom layouts. Hardware gets the most fields; software
  // license / consumable / facility / stockroom tweak a few. Anything not
  // listed here falls back to a generic dump of the envelope.
  const sections = ASSET_FIELD_LAYOUT[table] || ASSET_FIELD_LAYOUT.alm_asset;
  return (
    <>
      {rec.short_description && (
        <div className="section">
          <h3>Description</h3>
          <div className="kv-block">{rec.short_description}</div>
        </div>
      )}
      {sections.map((sec, i) => (
        <div className="section" key={i}>
          <h3>{sec.heading}</h3>
          <div className="fields">
            {sec.fields.map(f => {
              const visible = f.always || rec[f.key] !== undefined;
              if (!visible) return null;
              return (
                <Field key={f.key} label={f.label} showRaw={showRaw} raw={rec[f.key]}>
                  {f.render ? f.render(rec) : <AssetRef rec={rec} field={f.key} kind={f.kind} />}
                </Field>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}

const ASSET_FIELD_LAYOUT = {
  alm_hardware: [
    {
      heading: 'Identification', fields: [
        { key: 'asset_tag',     label: 'Asset tag',    render: (r) => <span className="mono">{r.asset_tag || '—'}</span> },
        { key: 'sys_id',        label: 'sys_id',       render: (r) => <span className="mono" style={{ color: 'var(--fg-3)', fontSize: 12 }}>{r.sys_id}</span> },
        { key: 'display_name',  label: 'Name',         render: (r) => <span>{r.display_name || '—'}</span> },
        { key: 'sys_class_name',label: 'Class',        render: (r) => <span className="mono" style={{ fontSize: 12 }}>{r.sys_class_name || '—'}</span> },
      ],
    },
    {
      heading: 'Hardware', fields: [
        { key: 'serial_number', label: 'Serial',       render: (r) => <span className="mono">{r.serial_number || '—'}</span> },
        { key: 'model',         label: 'Model',        kind: 'ci' },
        { key: 'model_category',label: 'Category',     kind: 'ci' },
        { key: 'manufacturer',  label: 'Manufacturer', kind: 'company' },
        { key: 'warranty_expiration', label: 'Warranty', render: (r) => <span>{r.warranty_expiration || '—'}</span> },
      ],
    },
    {
      heading: 'Lifecycle', fields: [
        { key: 'install_status',label: 'Status',       render: (r) => <span>{r.__display_install_status || r.install_status || '—'}</span> },
        { key: 'substatus',     label: 'Substatus',    render: (r) => <span>{r.__display_substatus || r.substatus || '—'}</span> },
        { key: 'install_date',  label: 'Installed',    render: (r) => <span>{r.install_date || '—'}</span> },
        { key: 'purchase_date', label: 'Purchased',    render: (r) => <span>{r.purchase_date || '—'}</span> },
        { key: 'retired',       label: 'Retired',      render: (r) => <span>{r.retired || '—'}</span> },
      ],
    },
    {
      heading: 'Ownership', fields: [
        { key: 'assigned_to',   label: 'Assigned to',  kind: 'user' },
        { key: 'owned_by',      label: 'Owned by',     kind: 'user' },
        { key: 'managed_by',    label: 'Managed by',   kind: 'user' },
        { key: 'department',    label: 'Department',   kind: 'department' },
        { key: 'company',       label: 'Company',      kind: 'company' },
        { key: 'cost_center',   label: 'Cost center',  kind: 'cost_center' },
        { key: 'location',      label: 'Location',     kind: 'location' },
      ],
    },
    {
      heading: 'Configuration item', fields: [
        { key: 'ci',            label: 'Linked CI',    kind: 'ci', always: true },
      ],
    },
  ],
  alm_software_license: [
    {
      heading: 'Identification', fields: [
        { key: 'asset_tag',    label: 'Asset tag',    render: (r) => <span className="mono">{r.asset_tag || '—'}</span> },
        { key: 'sys_id',       label: 'sys_id',       render: (r) => <span className="mono" style={{ fontSize: 12, color: 'var(--fg-3)' }}>{r.sys_id}</span> },
        { key: 'display_name', label: 'Name',         render: (r) => <span>{r.display_name || '—'}</span> },
        { key: 'vendor',       label: 'Vendor',       kind: 'company' },
      ],
    },
    {
      heading: 'License', fields: [
        { key: 'license_count',   label: 'Seats',          render: (r) => <span className="mono">{r.license_count || '—'}</span> },
        { key: 'expiration_date', label: 'Expires',        render: (r) => <span>{r.expiration_date || '—'}</span> },
        { key: 'license_key',     label: 'License key',    render: (r) => <span className="mono" style={{ fontSize: 11.5 }}>{r.license_key || '—'}</span> },
        { key: 'install_status',  label: 'Status',         render: (r) => <span>{r.__display_install_status || r.install_status || '—'}</span> },
      ],
    },
    {
      heading: 'Ownership', fields: [
        { key: 'owned_by',     label: 'Owned by',     kind: 'user' },
        { key: 'managed_by',   label: 'Managed by',   kind: 'user' },
        { key: 'company',      label: 'Company',      kind: 'company' },
        { key: 'cost_center',  label: 'Cost center',  kind: 'cost_center' },
      ],
    },
  ],
  alm_consumable: [
    {
      heading: 'Identification', fields: [
        { key: 'asset_tag',    label: 'Asset tag',  render: (r) => <span className="mono">{r.asset_tag || '—'}</span> },
        { key: 'sys_id',       label: 'sys_id',     render: (r) => <span className="mono" style={{ fontSize: 12, color: 'var(--fg-3)' }}>{r.sys_id}</span> },
        { key: 'display_name', label: 'Name',       render: (r) => <span>{r.display_name || '—'}</span> },
        { key: 'quantity',     label: 'Quantity',   render: (r) => <span className="mono">{r.quantity || '—'}</span> },
        { key: 'model',        label: 'Model',      kind: 'ci' },
      ],
    },
    {
      heading: 'Lifecycle', fields: [
        { key: 'install_status', label: 'Status',   render: (r) => <span>{r.__display_install_status || r.install_status || '—'}</span> },
        { key: 'location',     label: 'Location',   kind: 'location' },
      ],
    },
  ],
  alm_facility: [
    {
      heading: 'Identification', fields: [
        { key: 'asset_tag',    label: 'Asset tag',  render: (r) => <span className="mono">{r.asset_tag || '—'}</span> },
        { key: 'sys_id',       label: 'sys_id',     render: (r) => <span className="mono" style={{ fontSize: 12, color: 'var(--fg-3)' }}>{r.sys_id}</span> },
        { key: 'display_name', label: 'Name',       render: (r) => <span>{r.display_name || '—'}</span> },
        { key: 'install_status', label: 'Status',   render: (r) => <span>{r.__display_install_status || r.install_status || '—'}</span> },
        { key: 'location',     label: 'Location',   kind: 'location' },
      ],
    },
  ],
  sn_ent_facility_asset: [
    {
      heading: 'Identification', fields: [
        { key: 'asset_tag',     label: 'Asset tag',   render: (r) => <span className="mono">{r.asset_tag || '—'}</span> },
        { key: 'sys_id',        label: 'sys_id',      render: (r) => <span className="mono" style={{ fontSize: 12, color: 'var(--fg-3)' }}>{r.sys_id}</span> },
        { key: 'display_name',  label: 'Name',        render: (r) => <span>{r.display_name || '—'}</span> },
        { key: 'serial_number', label: 'Serial',      render: (r) => <span className="mono">{r.serial_number || '—'}</span> },
        { key: 'model',         label: 'Model',       kind: 'ci' },
        { key: 'sys_class_name',label: 'Class',       render: (r) => <span className="mono" style={{ fontSize: 12 }}>{r.sys_class_name || '—'}</span> },
      ],
    },
    {
      heading: 'Lifecycle', fields: [
        { key: 'install_status', label: 'Status',     render: (r) => <span>{r.__display_install_status || r.install_status || '—'}</span> },
        { key: 'substatus',      label: 'Substatus',  render: (r) => <span>{r.__display_substatus || r.substatus || '—'}</span> },
        { key: 'assigned_to',    label: 'Assigned to', kind: 'user' },
        { key: 'owned_by',       label: 'Owned by',   kind: 'user' },
        { key: 'location',       label: 'Location',   kind: 'location' },
      ],
    },
  ],
  alm_stockroom: [
    {
      heading: 'Stockroom', fields: [
        { key: 'name',         label: 'Name',       render: (r) => <span>{r.name || '—'}</span> },
        { key: 'sys_id',       label: 'sys_id',     render: (r) => <span className="mono" style={{ fontSize: 12, color: 'var(--fg-3)' }}>{r.sys_id}</span> },
        { key: 'display_name', label: 'Display',    render: (r) => <span>{r.display_name || '—'}</span> },
        { key: 'manager',      label: 'Manager',    kind: 'user' },
        { key: 'location',     label: 'Location',   kind: 'location' },
      ],
    },
  ],
  alm_asset: [
    {
      heading: 'Identification', fields: [
        { key: 'asset_tag',    label: 'Asset tag',  render: (r) => <span className="mono">{r.asset_tag || '—'}</span> },
        { key: 'sys_id',       label: 'sys_id',     render: (r) => <span className="mono" style={{ fontSize: 12, color: 'var(--fg-3)' }}>{r.sys_id}</span> },
        { key: 'display_name', label: 'Name',       render: (r) => <span>{r.display_name || '—'}</span> },
        { key: 'sys_class_name', label: 'Class',    render: (r) => <span className="mono" style={{ fontSize: 12 }}>{r.sys_class_name || '—'}</span> },
        { key: 'install_status', label: 'Status',   render: (r) => <span>{r.__display_install_status || r.install_status || '—'}</span> },
      ],
    },
    {
      heading: 'Ownership', fields: [
        { key: 'assigned_to',  label: 'Assigned to', kind: 'user' },
        { key: 'owned_by',     label: 'Owned by',    kind: 'user' },
        { key: 'company',      label: 'Company',     kind: 'company' },
        { key: 'cost_center',  label: 'Cost center', kind: 'cost_center' },
        { key: 'location',     label: 'Location',    kind: 'location' },
      ],
    },
    {
      heading: 'Configuration item', fields: [
        { key: 'ci',           label: 'Linked CI',   kind: 'ci', always: true },
      ],
    },
  ],
};

function AssetCITicketsSection({ rows, ci, ci_display }) {
  return (
    <div className="section">
      <h3>
        Tickets referencing the linked CI
        <span className="count">{rows.length}</span>
        <span style={{ marginLeft: 10, fontSize: 11.5, fontWeight: 400, color: 'var(--fg-3)' }}>
          via <RefLink kind="ci" sys_id={ci} fallback={ci_display} />
        </span>
      </h3>
      <div className="related-list" style={{ padding: 0, marginBottom: 12 }}>
        {rows.map(t => (
          <div key={t.sys_id + t._table} className="related-item"
               onClick={() => window.navigate(window.recordUrl(t._table, t.sys_id))}>
            <span className="num">{t.number}</span>
            <span className="desc">{t.short_description}</span>
            <span className="chip" style={{ marginLeft: 'auto', fontSize: 10.5 }}>
              {window.taskLabel(t._table, 'singular')}
            </span>
          </div>
        ))}
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

// Inline link to a catalog parent record (sc_request, sc_req_item, or
// sc_cat_item). Renders the display value (REQ0010001, RITM0010005, …)
// with the friendly URL and a small chip indicating the type.
function CatalogParentLink({ sys_id, display, target_table }) {
  if (!sys_id) return <span style={{ color: 'var(--fg-4)', fontStyle: 'italic' }}>—</span>;
  return (
    <span className="ref-link" onClick={() => window.navigate(window.recordUrl(target_table, sys_id))}>
      <span className="mono" style={{ marginRight: 4 }}>{display || sys_id_short(sys_id)}</span>
      <span style={{ color: 'var(--fg-4)', fontSize: 11.5 }}>· {window.taskLabel(target_table, 'singular')}</span>
    </span>
  );
}

function FieldsSection({ rec, table, showRaw }) {
  const isChange = window.CHANGE_STYLE_TABLES.has(table);
  // Catalog upward-chain: sc_task → sc_req_item → sc_request, plus the
  // catalog item definition the form was generated from. Each link is
  // shown only when the field is populated, so non-catalog tasks (which
  // happen to share the FieldsSection) don't get empty rows.
  const showCatalog = (table === 'sc_task' || table === 'sc_req_item' || table === 'sc_request');
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
      {showCatalog && (rec.request_item || rec.request || rec.cat_item) && (
        <div className="section">
          <h3>Catalog</h3>
          <div className="fields">
            {table === 'sc_task' && (
              <Field label="Requested item" showRaw={showRaw} raw={rec.request_item}>
                <CatalogParentLink sys_id={rec.request_item}
                  display={rec.__display_request_item}
                  target_table="sc_req_item" />
              </Field>
            )}
            {(table === 'sc_task' || table === 'sc_req_item') && (
              <Field label="Request" showRaw={showRaw} raw={rec.request}>
                <CatalogParentLink sys_id={rec.request}
                  display={rec.__display_request}
                  target_table="sc_request" />
              </Field>
            )}
            {rec.cat_item && (
              <Field label="Catalog item" showRaw={showRaw} raw={rec.cat_item}>
                <CatalogParentLink sys_id={rec.cat_item}
                  display={rec.__display_cat_item}
                  target_table="sc_cat_item" />
              </Field>
            )}
          </div>
        </div>
      )}
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
        {approvals.map(a => {
          const groupDisplay = a.group
            ? (a.__display_group || window.findGroup(a.group)?.name || sys_id_short(a.group))
            : null;
          return (
            <div key={a.sys_id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-elev)' }}>
              <window.UserCell sys_id={a.approver} displayName={a.__display_approver} />
              {groupDisplay && (
                <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
                  via <span className="ref-link" onClick={(e) => { e.stopPropagation(); window.navigate(`/groups/${a.group}`); }}>{groupDisplay}</span>
                </span>
              )}
              <span style={{ marginLeft: 'auto' }}>
                <span className={`chip ${stateChipColor(a.state)}`}>{a.__display_state || a.state}</span>
              </span>
            </div>
          );
        })}
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

function EmailsTab({ resp }) {
  if (resp == null) return <_LoadingTab label="loading emails…" />;
  const rows = resp.rows || [];
  if (!rows.length) {
    return <div className="empty"><div className="glyph"><window.Icon name="info" /></div>No emails on this record.</div>;
  }
  const truncated = rows.length < (resp.total || 0);
  const inbound = (t) => /rece/i.test(String(t || ''));  // received vs sent/ready
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {rows.map(e => (
        <div key={e.sys_id} style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="chip" style={{ fontSize: 10.5 }}>{inbound(e.type) ? '↓ in' : '↑ out'}</span>
            <span style={{ fontSize: 13, fontWeight: 500, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.subject || '(no subject)'}</span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--fg-4)', whiteSpace: 'nowrap' }}>{e.sys_created_on}</span>
          </div>
          {(e.recipients || e.state) && (
            <div style={{ fontSize: 11.5, color: 'var(--fg-3)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {e.recipients ? `to ${e.recipients}` : ''}{e.recipients && e.state ? ' · ' : ''}{e.state || ''}
            </div>
          )}
        </div>
      ))}
      {truncated && <div style={{ fontSize: 11, color: 'var(--fg-4)', padding: '4px 2px' }}>Showing first {rows.length} of {resp.total.toLocaleString()}.</div>}
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
