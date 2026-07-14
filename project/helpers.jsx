/* eslint-disable */
// Shared helpers, icons, lookups, hash router

// ---------- Hash router ----------
window.useRoute = function useRoute() {
  const [route, setRoute] = React.useState(() => parseHash());
  React.useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return [route, navigate];
};

// URL slug → ServiceNow table for friendly routes.
window.URL_TO_TABLE = {
  incidents:         'incident',
  changes:           'change_request',
  problems:          'problem',
  requests:          'sc_request',
  'requested-items': 'sc_req_item',
  'catalog-tasks':   'sc_task',
  'catalog-items':   'sc_cat_item',
  'group-approvals': 'sysapproval_group',
  'asset-tasks':     'asset_task',
  'contract-renewal-tasks': 'sn_contract_renewal_task',
  hardware:          'alm_hardware',
  licenses:          'alm_license',
  consumables:       'alm_consumable',
  facilities:        'alm_facility',
  stockrooms:        'alm_stockroom',
  'facility-assets': 'sn_ent_facility_asset',
  assets:            'alm_asset',
  software:          'cmdb_ci_spkg',
  'software-installs': 'cmdb_software_instance',
  users:             'sys_user',
  groups:            'sys_user_group',
  delegations:       'sys_user_delegate',
  knowledge:         'kb_knowledge',
  templates:         'sys_template',
  cis:               'cmdb_ci',
  audit:             'audit_log',
  'business-rules':  'sys_script',
  'client-scripts':  'sys_script_client',
  'script-includes': 'sys_script_include',
  'scheduled-jobs':  'sysauto_script',
  'ui-policies':     'sys_ui_policy',
  'data-policies':   'sys_data_policy2',
  'sla-definitions': 'contract_sla',
  'inbound-email-actions': 'sysevent_in_email_action',
  'notifications':   'sysevent_email_action',
  locations:         'cmn_location',
  flows:             'flow_inventory',
  // Event/alert logic
  'event-registry':            'sysevent_register',
  'event-script-actions':      'sysevent_script_action',
  'notification-templates':    'sysevent_email_template',
  'event-match-rules':         'em_match_rule',
  'alert-correlation-rules':   'em_alert_correlation_rule',
  'alert-management-rules':    'em_alert_management_rule',
  'alert-impact-rules':        'em_impact_rule',
  'event-connectors':          'em_connector_definition',
  'event-connector-instances': 'em_connector_instance',
};
window.TABLE_TO_URL = Object.fromEntries(
  Object.entries(window.URL_TO_TABLE).map(([k, v]) => [v, k])
);

function parseHash() {
  const h = window.location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = h.split('?');
  const parts = path.split('/').filter(Boolean);
  // /                            -> { view: 'home' }
  // /<friendly>                  -> { view: 'list', table }
  // /<friendly>/:sys_id          -> { view: 'record', table, sys_id }
  // /tasks/<sntable>             -> { view: 'list', table }   (fallback for tables without a friendly slug)
  // /tasks/<sntable>/:sys_id     -> { view: 'record', table, sys_id }
  // /service-catalog             -> { view: 'service_catalog_home' }
  if (parts.length === 0) return { view: 'home' };

  if (parts[0] === 'service-catalog') {
    return { view: 'service_catalog_home' };
  }

  if (parts[0] === 'logic') {
    return { view: 'logic_home' };
  }

  if (parts[0] === 'cmdb') {
    return { view: 'cmdb_home' };
  }

  if (parts[0] === 'service-status') {
    return { view: 'service_status_home' };
  }

  if (parts[0] === 'sn-table') {
    if (parts.length < 2) return { view: 'logic_home' };
    return { view: 'sn_table_inspector', name: parts[1] };
  }

  if (parts[0] === 'tasks') {
    if (parts.length === 1) return { view: 'home' };
    const t = parts[1];
    if (parts.length === 2) return { view: 'list', table: t, query: qs };
    if (parts.length === 3 && parts[2] === 'analytics' && (window.TASK_TABLES || []).includes(t)) {
      return { view: 'task_analytics', table: t, query: qs };
    }
    return { view: 'record', table: t, sys_id: parts[2] };
  }

  const table = window.URL_TO_TABLE[parts[0]];
  if (!table) return { view: 'home' };
  if (table === 'audit_log') return { view: 'audit_log' };
  if (parts.length === 1) return { view: 'list', table, query: qs };
  if (parts.length === 2 && parts[1] === 'analytics' && (window.TASK_TABLES || []).includes(table)) {
    return { view: 'task_analytics', table, query: qs };
  }
  return { view: 'record', table, sys_id: parts[1] };
}

window.navigate = function navigate(path) {
  window.location.hash = path;
};

// Helper: fetch the loaded array for a task table, accounting for the two
// alias keys (incident → incidents, change_request → changes).
window.getTaskRecords = function (table) {
  const d = window.HistoricalWowData;
  if (table === 'incident') return d.incidents;
  if (table === 'change_request') return d.changes;
  return d[table] || [];
};

// Build URLs for navigate() — falls back to /tasks/<sntable> for tables
// without a dedicated friendly slug.
window.recordUrl = function (table, sys_id) {
  const slug = window.TABLE_TO_URL[table];
  return slug ? `/${slug}/${sys_id}` : `/tasks/${table}/${sys_id}`;
};
window.listUrl = function (table) {
  const slug = window.TABLE_TO_URL[table];
  return slug ? `/${slug}` : `/tasks/${table}`;
};
window.urlWithQuery = function urlWithQuery(path, values) {
  const params = values instanceof URLSearchParams ? values : new URLSearchParams();
  if (!(values instanceof URLSearchParams)) {
    for (const [key, value] of Object.entries(values || {})) {
      if (value != null && value !== '') params.set(key, value);
    }
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
};
window.filteredListUrl = function filteredListUrl(table, filters, q) {
  const values = { ...(filters || {}) };
  if (q) values.q = q;
  return window.urlWithQuery(window.listUrl(table), values);
};
window.taskAnalyticsUrl = function taskAnalyticsUrl(table) {
  return `${window.listUrl(table)}/analytics`;
};

// Tables whose record detail follows the change-request layout (Type, Risk,
// Start/End dates, Requested by). Everything else uses the incident layout
// (Caller, Priority/Impact/Urgency, Category, Contact type).
window.CHANGE_STYLE_TABLES = new Set([
  'change_request', 'change_phase', 'change_request_imac', 'std_change_proposal',
]);

// ---------- Decoders ----------
window.decodeChoice = function (table, element, value) {
  const data = window.HistoricalWowData;
  if (value == null || value === '') return { label: '', value: '' };
  // Try the concrete table first, then the inherited task definition. Task
  // list rows also carry __display_<field>; this is the fallback for slim or
  // older payloads where that display value is unavailable.
  const exact = data.sys_choice.find(
    (c) => c.table === table && c.element === element && String(c.value) === String(value)
  );
  const c = exact || data.sys_choice.find(
    (c) => c.table === 'task' && c.element === element && String(c.value) === String(value)
  );
  return { label: c ? c.label : String(value), value: String(value) };
};

window.findUser = (sys_id) => {
  if (!sys_id) return null;
  const d = window.HistoricalWowData;
  // Prefer the compact lookup map (eager-loaded, ~3 MB gzipped). Components
  // that need the full user envelope (UserRefPage) call data.fetchRecord.
  const m = d.sys_user_lookup;
  if (m && m.has && m.has(sys_id)) {
    return { sys_id, ...m.get(sys_id) };
  }
  // Fallback: legacy array (only populated when something explicitly fetched a full user).
  return d.sys_user.find((u) => u.sys_id === sys_id) || null;
};
window.findGroup = (sys_id) => window.HistoricalWowData.sys_user_group.find((g) => g.sys_id === sys_id);
window.findCI = (sys_id) => {
  if (!sys_id) return null;
  const d = window.HistoricalWowData;
  // Prefer the compact lookup map (eager-loaded, ~5 MB gzipped). For full
  // CI records (CIRefPage), components fetch via data.fetchRecord('cmdb_ci', sys_id).
  const m = d.cmdb_ci_lookup;
  if (m && m.has && m.has(sys_id)) {
    const stub = m.get(sys_id);
    return { sys_id, ...stub };
  }
  // Fallback: legacy array (only populated if CIRefPage cached a full record there).
  return d.cmdb_ci.find((c) => c.sys_id === sys_id) || null;
};
window.findCompany = (sys_id) => window.HistoricalWowData.companies.find((c) => c.sys_id === sys_id);
window.findDepartment = (sys_id) => window.HistoricalWowData.departments.find((d) => d.sys_id === sys_id);
window.findLocation = (sys_id) => window.HistoricalWowData.locations.find((l) => l.sys_id === sys_id);
window.findCostCenter = (sys_id_or_code) => {
  if (!sys_id_or_code) return null;
  const arr = window.HistoricalWowData.cost_centers || [];
  return arr.find((c) => c.sys_id === sys_id_or_code) ||
         arr.find((c) => c.code === sys_id_or_code) ||
         null;
};

// ---------- Avatar color ----------
window.avatarColor = function (seed) {
  if (!seed) return 'oklch(60% 0.06 95)';
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `oklch(58% 0.07 ${hue})`;
};
window.initials = function (name) {
  if (!name) return '–';
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

// ---------- Date helpers ----------
window.fmtDate = function (s) {
  if (!s) return '—';
  // s like "2026-04-28 06:12:33"
  return s.replace(' ', ' · ');
};
window.fmtRelative = function (s) {
  if (!s) return '';
  // Anchor relative-time math at the snapshot's captured_at, not the
  // browser's real clock: this is a static archive and the user is viewing
  // a frozen moment. Otherwise everything would slowly drift to "X months
  // ago" forever.
  const ref = window.HistoricalWowData?.manifest?.captured_at;
  const now = ref ? new Date(ref) : new Date();
  const t = new Date(s.replace(' ', 'T') + 'Z');
  const diff = (now - t) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 86400 * 30) return Math.floor(diff / 86400) + 'd ago';
  if (diff < 86400 * 365) return Math.floor(diff / 86400 / 30) + 'mo ago';
  return Math.floor(diff / 86400 / 365) + 'y ago';
};

window.fmtBytes = function (n) {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(n < 10 && i > 0 ? 1 : 0) + ' ' + u[i];
};

// ---------- Priority + state styling ----------
window.priorityChipClass = function (p) {
  switch (String(p)) {
    case '1': return 'red';
    case '2': return 'amber';
    case '3': return 'blue';
    case '4': return 'green';
    case '5': return 'violet';
    default: return '';
  }
};
window.stateChipClass = function (table, s) {
  const v = String(s);
  if (table === 'incident') {
    if (v === '1') return 'amber';      // New
    if (v === '2') return 'blue';       // In Progress
    if (v === '3') return 'violet';     // On Hold
    if (v === '6') return 'green';      // Resolved
    if (v === '7') return '';           // Closed (gray)
    if (v === '8') return 'red';        // Canceled
  }
  if (table === 'change_request') {
    if (v === '-5' || v === '-4') return 'amber';
    if (v === '-3' || v === '-2') return 'blue';
    if (v === '-1') return 'violet';
    if (v === '0') return 'amber';
    if (v === '3') return '';
    if (v === '4') return 'red';
  }
  return '';
};

window.priorityBars = function (p) {
  const cls = (() => {
    switch (String(p)) {
      case '1': return 'crit';
      case '2': return 'high';
      case '3': return 'med';
      default: return 'low';
    }
  })();
  const filled = 5 - Math.max(0, Math.min(4, parseInt(p, 10) - 1));
  return { cls, filled };
};

// ---------- Icons (small, line-based) ----------
window.Icon = function Icon({ name, size = 14, strokeWidth = 1.6 }) {
  const paths = {
    search: <><circle cx="11" cy="11" r="6" /><path d="m20 20-3.2-3.2" /></>,
    incident: <><path d="M12 3 2 20h20L12 3z" /><path d="M12 10v5" /><circle cx="12" cy="17.5" r="0.6" fill="currentColor" /></>,
    change: <><path d="M3 7h13" /><path d="M16 4l3 3-3 3" /><path d="M21 17H8" /><path d="M8 14l-3 3 3 3" /></>,
    user: <><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-7 8-7s8 3 8 7" /></>,
    users: <><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3.5 3-6 6-6s6 2.5 6 6" /><circle cx="17" cy="9" r="2.6" /><path d="M14 13.5c1-.6 2-.9 3-.9 3 0 5 2 5 5" /></>,
    ci: <><rect x="3" y="3" width="7" height="7" rx="1.2" /><rect x="14" y="3" width="7" height="7" rx="1.2" /><rect x="3" y="14" width="7" height="7" rx="1.2" /><rect x="14" y="14" width="7" height="7" rx="1.2" /></>,
    home: <><path d="M3 12 12 4l9 8" /><path d="M5 11v9h14v-9" /></>,
    pin: <><path d="M12 21s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12z" /><circle cx="12" cy="9" r="2.5" /></>,
    chevron_right: <><path d="m9 6 6 6-6 6" /></>,
    chevron_down: <><path d="m6 9 6 6 6-6" /></>,
    download: <><path d="M12 4v12" /><path d="m6 12 6 6 6-6" /><path d="M5 20h14" /></>,
    paperclip: <><path d="M21 11 12 20a5 5 0 0 1-7-7l9-9a3.5 3.5 0 1 1 5 5l-9 9a2 2 0 1 1-3-3l8-8" /></>,
    book: <><path d="M4 4h11a3 3 0 0 1 3 3v13" /><path d="M4 4v15h11a3 3 0 0 1 3 1" /></>,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 7v5l3 2" /></>,
    eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
    eye_off: <><path d="M9.7 5.2A11 11 0 0 1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-3.2 4.1" /><path d="M6.6 6.6A18 18 0 0 0 2 12s3.5 7 10 7a11 11 0 0 0 4.5-1" /><path d="m4 4 16 16" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9c.4.4 1 .6 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
    close: <><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>,
    check: <><path d="m4 12 5 5L20 6" /></>,
    filter: <><path d="M3 5h18" /><path d="M6 12h12" /><path d="M10 19h4" /></>,
    arrow_right: <><path d="M5 12h14" /><path d="m13 5 7 7-7 7" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><circle cx="12" cy="8" r="0.6" fill="currentColor" /></>,
    lock: <><rect x="4" y="11" width="16" height="10" rx="1.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
    unlock: <><rect x="4" y="11" width="16" height="10" rx="1.5" /><path d="M8 11V8a4 4 0 0 1 7-1" /></>,
    db: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></>,
    star: <><path d="M12 3l2.7 5.7 6.3.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.3-.9z" /></>,
    file: <><path d="M14 3H6v18h12V7z" /><path d="M14 3v4h4" /></>,
    folder: <><path d="M3 6h6l2 2h10v11H3z" /></>,
    link: <><path d="M10 14a4 4 0 0 0 5.6 0l3-3a4 4 0 0 0-5.6-5.6l-1 1" /><path d="M14 10a4 4 0 0 0-5.6 0l-3 3a4 4 0 0 0 5.6 5.6l1-1" /></>,
    refresh: <><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" /></>,
    shield: <><path d="M12 3 4 6v6c0 5 3.5 8.5 8 9 4.5-.5 8-4 8-9V6z" /></>,
    flag: <><path d="M5 21V4" /><path d="M5 4h13l-2 4 2 4H5" /></>,
    archive: <><rect x="3" y="3" width="18" height="5" rx="1" /><path d="M5 8v12h14V8" /><path d="M10 12h4" /></>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      {paths[name] || null}
    </svg>
  );
};

// ---------- Avatar ----------
window.Avatar = function Avatar({ name, size }) {
  const cls = ['avatar', size === 'sm' ? 'sm' : size === 'lg' ? 'lg' : size === 'xl' ? 'xl' : ''].filter(Boolean).join(' ');
  return (
    <div className={cls} style={{ background: window.avatarColor(name) }}>
      {window.initials(name)}
    </div>
  );
};

// ---------- UserCell ----------
// `displayName` is the fallback when findUser fails (sys_id wasn't in our
// snapshot — e.g. deactivated user). Pass `r.__display_assigned_to` etc.
window.UserCell = function UserCell({ sys_id, displayName, asLink = true, sm = true }) {
  if (!sys_id) return <span style={{ color: 'var(--fg-4)', fontStyle: 'italic' }}>—</span>;
  const u = window.findUser(sys_id);
  const name = u?.name || displayName || sys_id.slice(0, 8) + '…';
  const isResolved = !!u;
  const inner = (
    <span className="user-cell">
      <window.Avatar name={name} size={sm ? 'sm' : null} />
      <span className="name">{name}</span>
    </span>
  );
  if (!asLink || !isResolved) {
    // No user record → nowhere to navigate; render plain.
    return <span title={isResolved ? '' : 'User not in snapshot'}>{inner}</span>;
  }
  return (
    <span onClick={(e) => { e.stopPropagation(); window.navigate(`/users/${u.sys_id}`); }}>
      {inner}
    </span>
  );
};

// ---------- Audit log (page-view tracking, stored in memory) ----------
window.AuditLog = (() => {
  const entries = [];
  return {
    push: (kind, target, label) => {
      entries.unshift({
        ts: new Date().toISOString(),
        kind, target, label,
      });
      if (entries.length > 200) entries.length = 200;
    },
    all: () => entries.slice(),
  };
})();
