/* eslint-disable */
// Main app shell, sidebar, topbar, audit log overlay, router

const { useState, useEffect, useCallback } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accentHue": 155,
  "density": "balanced",
  "fontScale": 1,
  "showBanner": true,
  "showRawDefault": false,
  "sidebarCollapsed": false,
  "monoTokens": true,
  "showRelativeDates": true
}/*EDITMODE-END*/;

// Tables whose list view is handled by logic.jsx (and therefore should NOT
// fall through to the generic ListPage). sys_ui_policy and sys_data_policy2
// have list pages in logic.jsx but no custom record page — those records
// still go to the generic RecordPage below, which is why
// LOGIC_RECORD_TABLES is the smaller set.
const LOGIC_LIST_TABLES = new Set([
  'sys_script', 'sys_script_client', 'sys_script_include',
  'sysauto_script', 'sys_ui_policy', 'sys_data_policy2',
]);
const LOGIC_RECORD_TABLES = new Set([
  'sys_script', 'sys_script_client', 'sys_script_include', 'sysauto_script',
  'sysevent_in_email_action', 'sysevent_email_action', 'contract_sla',
]);

function applyTweaks(t) {
  const r = document.documentElement.style;
  // Lightness/chroma values match the dark palette in styles.css — the
  // accent stripe is bright (72%) so it pops on the 21% page bg, and
  // the accent-bg sits at ~28% so chip pills lift just barely above
  // the surface without going washed-out.
  r.setProperty('--accent',        `oklch(72% 0.13 ${t.accentHue})`);
  r.setProperty('--accent-2',      `oklch(78% 0.13 ${t.accentHue})`);
  r.setProperty('--accent-bg',     `oklch(28% 0.055 ${t.accentHue})`);
  r.setProperty('--accent-border', `oklch(42% 0.090 ${t.accentHue})`);
  r.setProperty('--accent-fg',     `oklch(82% 0.11 ${t.accentHue})`);
  r.setProperty('--selected',      `oklch(32% 0.055 ${t.accentHue})`);
  // density tweaks row padding via CSS var; simple approach: tweak base font size
  const base = ({ compact: 12.5, balanced: 13.5, comfy: 14.5 })[t.density] || 13.5;
  document.body.style.fontSize = (base * (t.fontScale || 1)) + 'px';
  document.documentElement.style.setProperty('--banner-h', t.showBanner ? '28px' : '0px');
  const banner = document.querySelector('.banner');
  if (banner) banner.style.display = t.showBanner ? '' : 'none';
  document.documentElement.style.setProperty('--sidebar-w', t.sidebarCollapsed ? '64px' : '244px');
}

function App() {
  const [route] = window.useRoute();
  const [tweaks, setTweak] = window.useTweaks(TWEAK_DEFAULTS);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [showRaw, setShowRaw] = useState(TWEAK_DEFAULTS.showRawDefault);
  const [auditOpen, setAuditOpen] = useState(false);
  const [hrModalOpen, setHrModalOpen] = useState(false);
  const data = window.HistoricalWowData;

  // Re-render whenever the loader notifies (table-by-table progress, then ready).
  const [, forceUpdate] = useState(0);
  useEffect(() => data.subscribe(() => forceUpdate((n) => n + 1)), []);

  useEffect(() => { applyTweaks(tweaks); }, [tweaks]);

  useEffect(() => {
    const onKey = (e) => {
      const isK = (e.key === 'k' || e.key === 'K');
      if (isK && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen(true);
      }
      if (e.key === '/' && !['INPUT','TEXTAREA'].includes(e.target.tagName)) {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Default landing — track route changes for audit
  useEffect(() => {
    if (route.view === 'list') window.AuditLog.push('list', route.table, '');
    if (route.view === 'home') window.AuditLog.push('view', 'home', 'Snapshot landing');
    if (route.view === 'service_catalog_home') window.AuditLog.push('view', 'service-catalog', 'Service catalog overview');
    if (route.view === 'logic_home') window.AuditLog.push('view', 'logic', 'Server/client-side logic overview');
    if (route.view === 'sn_table_inspector') window.AuditLog.push('view', `sn-table/${route.name}`, `Logic on ${route.name}`);
  }, [route.view, route.table, route.name]);

  if (!data.loadStatus.ready) {
    return <LoadingScreen status={data.loadStatus} />;
  }

  return (
    <div className="app">
      <div className="banner">
        <div className="left">
          <span className="dot"></span>
          <span>
            <strong style={{ fontWeight: 600 }}>Read-only archive</strong>
            {data.whoami.access_log ? ' · all reads logged' : ''}
          </span>
        </div>
        <div className="right">
          <span>snapshot {data.manifest.label}</span>
          <span>·</span>
          <span>captured {data.manifest.snapshot_date}</span>
          <span>·</span>
          <span>source {data.manifest.instance}</span>
          <span>·</span>
          <span>sha {data.manifest.integrity.sha256_manifest.slice(0, 10)}</span>
        </div>
      </div>

      <div className="topbar">
        <div className="brand" onClick={() => window.navigate('/')} style={{ cursor: 'pointer' }}>
          <div className="logo">H</div>
          {!tweaks.sidebarCollapsed && <span>HistoricalNow</span>}
        </div>
        <div className="search-wrap">
          <div className="search-trigger" onClick={() => setPaletteOpen(true)}>
            <window.Icon name="search" size={14} />
            <span>Search incidents, changes, users, groups, CIs, journal…</span>
            <span className="kbd">
              <kbd>⌘</kbd><kbd>K</kbd>
            </span>
          </div>
        </div>
        <div className="controls">
          {data.hrStatus.enabled && (
            <HrGateButton
              status={data.hrStatus}
              onUnlockClick={() => setHrModalOpen(true)}
              onLockClick={async () => {
                await data.lockHr();
                window.location.reload();
              }}
            />
          )}
          <a className="toggle" href="/docs/" title="OpenAPI spec, schema reference, and interactive try-it-out"
             style={{ textDecoration: 'none' }}>
            <window.Icon name="book" size={13} />
            <span>docs</span>
          </a>
          <button className={'toggle' + (showRaw ? ' on' : '')} onClick={() => setShowRaw(v => !v)} title="Show raw values alongside display values">
            <window.Icon name={showRaw ? 'eye' : 'eye_off'} size={13} />
            <span>raw</span>
          </button>
          <button className="icon-btn" onClick={() => setAuditOpen(true)} title="My access audit log">
            <window.Icon name="history" size={14} />
          </button>
          <div className="divider-v" />
          <WhoamiBadge whoami={data.whoami} />
        </div>
      </div>

      <div className="app-shell-body">
        <Sidebar route={route} />
        <main className="main">
          {route.view === 'home' && <window.HomePage openPalette={() => setPaletteOpen(true)} />}
          {route.view === 'service_catalog_home' && <window.CatalogOverviewPage />}
          {route.view === 'logic_home' && <window.LogicHomePage />}
          {route.view === 'cmdb_home' && <window.CMDBOverviewPage />}
          {route.view === 'sn_table_inspector' && <window.SnTableInspectorPage name={route.name} />}
          {route.view === 'list' && route.table === 'sc_cat_item' && <window.CatalogItemListPage />}
          {route.view === 'list' && route.table === 'sys_script' && <window.BusinessRuleListPage />}
          {route.view === 'list' && route.table === 'sys_script_client' && <window.ClientScriptListPage />}
          {route.view === 'list' && route.table === 'sys_script_include' && <window.ScriptIncludeListPage />}
          {route.view === 'list' && route.table === 'sysauto_script' && <window.ScheduledJobListPage />}
          {route.view === 'list' && route.table === 'sys_ui_policy' && <window.UIPolicyListPage />}
          {route.view === 'list' && route.table === 'sys_data_policy2' && <window.DataPolicyListPage />}
          {route.view === 'list' && !LOGIC_LIST_TABLES.has(route.table) && route.table !== 'sc_cat_item' && <window.ListPage table={route.table} />}
          {route.view === 'record' && route.table === 'sc_cat_item' && <window.CatalogItemRecordPage sys_id={route.sys_id} showRaw={showRaw} />}
          {route.view === 'record' && route.table === 'sys_script' && <window.BusinessRuleRecordPage sys_id={route.sys_id} />}
          {route.view === 'record' && route.table === 'sys_script_client' && <window.ClientScriptRecordPage sys_id={route.sys_id} />}
          {route.view === 'record' && route.table === 'sys_script_include' && <window.ScriptIncludeRecordPage sys_id={route.sys_id} />}
          {route.view === 'record' && route.table === 'sysauto_script' && <window.ScheduledJobRecordPage sys_id={route.sys_id} />}
          {route.view === 'record' && route.table === 'kb_knowledge' && <window.KBRecordPage sys_id={route.sys_id} />}
          {route.view === 'record' && route.table === 'sys_template' && <window.TemplateRecordPage sys_id={route.sys_id} />}
          {route.view === 'record' && route.table === 'sysevent_in_email_action' && <window.InboundEmailActionRecordPage sys_id={route.sys_id} />}
          {route.view === 'record' && route.table === 'sysevent_email_action' && <window.NotificationRecordPage sys_id={route.sys_id} />}
          {route.view === 'record' && route.table === 'contract_sla' && <window.SLADefinitionRecordPage sys_id={route.sys_id} />}
          {route.view === 'record' && !LOGIC_RECORD_TABLES.has(route.table) && route.table !== 'sc_cat_item' && route.table !== 'kb_knowledge' && route.table !== 'sys_template' && <window.RecordPage table={route.table} sys_id={route.sys_id} showRaw={showRaw} />}
          {route.view === 'reference_user' && <window.UserRefPage sys_id={route.sys_id} />}
          {route.view === 'reference_group' && <window.GroupRefPage sys_id={route.sys_id} />}
          {route.view === 'reference_ci' && <window.CIRefPage sys_id={route.sys_id} />}
        </main>
      </div>

      <window.KPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      {auditOpen && <AuditLogPanel onClose={() => setAuditOpen(false)} />}
      {hrModalOpen && (
        <HrUnlockModal
          status={data.hrStatus}
          onClose={() => setHrModalOpen(false)}
          onSuccess={() => {
            setHrModalOpen(false);
            window.AuditLog.push('view', 'hr-unlock', `unlocked ${data.hrStatus.group_label}`);
            window.location.reload();
          }}
        />
      )}

      <window.TweaksPanel title="Tweaks">
        <window.TweakSection label="Theme" />
        <window.TweakSlider label="Accent hue" value={tweaks.accentHue} min={0} max={360} step={5} unit="°"
          onChange={(v) => setTweak('accentHue', v)} />
        <div style={{ display: 'flex', gap: 4, marginTop: -4, marginBottom: 2 }}>
          {[155, 95, 245, 295, 25, 75].map(h => (
            <button key={h} onClick={() => setTweak('accentHue', h)}
              style={{ width: 22, height: 22, borderRadius: 6, border: tweaks.accentHue === h ? '2px solid #29261b' : '1px solid rgba(0,0,0,.12)',
                       background: `oklch(58% 0.11 ${h})`, cursor: 'pointer' }} />
          ))}
        </div>

        <window.TweakSection label="Density" />
        <window.TweakRadio label="Row density" value={tweaks.density}
          options={['compact', 'balanced', 'comfy']}
          onChange={(v) => setTweak('density', v)} />
        <window.TweakSlider label="Font scale" value={tweaks.fontScale} min={0.9} max={1.2} step={0.05}
          onChange={(v) => setTweak('fontScale', v)} />

        <window.TweakSection label="Layout" />
        <window.TweakToggle label="Snapshot banner" value={tweaks.showBanner}
          onChange={(v) => setTweak('showBanner', v)} />
        <window.TweakToggle label="Collapse sidebar" value={tweaks.sidebarCollapsed}
          onChange={(v) => setTweak('sidebarCollapsed', v)} />

        <window.TweakSection label="Display" />
        <window.TweakToggle label="Raw values by default" value={tweaks.showRawDefault}
          onChange={(v) => { setTweak('showRawDefault', v); setShowRaw(v); }} />
        <window.TweakToggle label="Mono tokens" value={tweaks.monoTokens}
          onChange={(v) => setTweak('monoTokens', v)} />
        <window.TweakToggle label="Relative dates" value={tweaks.showRelativeDates}
          onChange={(v) => setTweak('showRelativeDates', v)} />
      </window.TweaksPanel>
    </div>
  );
}

function LoadingScreen({ status }) {
  const pct = status.total ? Math.round((status.loaded / status.total) * 100) : 0;
  const subline = status.error
    ? `Error: ${status.error}`
    : status.source === 'mock'
      ? 'No exports found in data/ — falling back to mock seed.'
      : status.table
        ? `Loading ${status.table} (${status.loaded} of ${status.total})`
        : 'Initializing…';
  return (
    <div style={{
      height: '100vh', display: 'grid', placeItems: 'center',
      background: 'var(--bg)', fontFamily: 'var(--font-sans)',
    }}>
      <div style={{ width: 'min(420px, 86vw)', textAlign: 'center' }}>
        <div className="dot-pulse" style={{ margin: '0 auto 18px' }} />
        <div style={{ fontSize: 11, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '.08em', fontWeight: 600 }}>
          ServiceNow Historical Archive
        </div>
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: '4px 0 6px', letterSpacing: '-.01em' }}>
          Loading archive…
        </h1>
        <div style={{ fontSize: 12.5, color: 'var(--fg-3)', minHeight: 18 }}>{subline}</div>
        <div style={{ marginTop: 16, height: 4, background: 'var(--bg-3)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{
            height: '100%', width: pct + '%',
            background: status.error ? 'var(--c-red)' : 'var(--accent)',
            transition: 'width .25s ease',
          }} />
        </div>
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--fg-4)', fontFamily: 'var(--font-mono)' }}>
          {status.source === 'export' ? 'fetching reference lookups' : status.source === 'mock' ? 'mock seed' : ' '}
        </div>
      </div>
    </div>
  );
}

function Sidebar({ route }) {
  const data = window.HistoricalWowData;
  const tcount = (t) => data.manifest.tables.find(x => x.table === t)?.source_rows;
  // Helper: only include nav entry if the table has rows on this snapshot
  // (so we don't list empty types — e.g. sysapproval_group might be 0
  // somewhere). null sentinel = always show.
  const navItem = (id, icon, label, table) => {
    const c = tcount(table);
    if (table && c === 0) return null;  // skip empty
    return { id, icon, label, count: c };
  };
  const items = [
    { id: '/', icon: 'home', label: 'Snapshot' },
    { sep: 'Tickets' },
    navItem('/incidents',       'incident', 'Incidents',        'incident'),
    navItem('/problems',        'flag',     'Problems',         'problem'),
    { sep: 'Changes' },
    navItem('/changes',         'change',   'Change requests',  'change_request'),
    { sep: 'Service catalog' },
    { id: '/service-catalog', icon: 'star',  label: 'Catalog overview' },
    { id: '/catalog-items',   icon: 'book',  label: 'Catalog items', count: data.manifest.tables.find(t => t.table === 'sc_cat_item')?.source_rows },
    navItem('/requests',        'folder',   'Requests',         'sc_request'),
    navItem('/requested-items', 'file',     'Requested items',  'sc_req_item'),
    navItem('/catalog-tasks',   'check',    'Catalog tasks',    'sc_task'),
    { sep: 'Approvals' },
    navItem('/group-approvals', 'shield',   'Group approvals',  'sysapproval_group'),
    { sep: 'Asset' },
    navItem('/hardware',        'ci',       'Hardware',         'alm_hardware'),
    navItem('/licenses',        'file',     'Licenses',         'alm_license'),
    navItem('/consumables',     'archive',  'Consumables',      'alm_consumable'),
    navItem('/facilities',      'archive',  'Facilities',       'alm_facility'),
    navItem('/facility-assets', 'ci',       'Facility assets',  'sn_ent_facility_asset'),
    navItem('/stockrooms',      'folder',   'Stockrooms',       'alm_stockroom'),
    navItem('/asset-tasks',     'archive',  'Asset tasks',      'asset_task'),
    navItem('/contract-renewal-tasks', 'archive', 'Contract renewal tasks', 'sn_contract_renewal_task'),
    { sep: 'Software' },
    navItem('/software',          'book',  'Software packages', 'cmdb_ci_spkg'),
    navItem('/software-installs', 'db',    'Software installs', 'cmdb_software_instance'),
    { sep: 'Reference' },
    navItem('/users',           'user',     'Users',            'sys_user'),
    navItem('/groups',          'users',    'Groups',           'sys_user_group'),
    navItem('/delegations',     'link',     'Delegations',      'sys_user_delegate'),
    navItem('/knowledge',       'book',     'Knowledge',        'kb_knowledge'),
    navItem('/templates',       'file',     'Templates',        'sys_template'),
    { id: '/cmdb',              icon: 'ci',    label: 'CMDB overview' },
    navItem('/cis',             'ci',       'Configuration items', 'cmdb_ci'),
    { sep: 'Logic' },
    { id: '/logic',             icon: 'settings', label: 'Overview' },
    navItem('/business-rules',  'flag',     'Business rules',   'sys_script'),
    navItem('/client-scripts',  'change',   'Client scripts',   'sys_script_client'),
    navItem('/scheduled-jobs',  'history',  'Scheduled jobs',   'sysauto_script'),
    navItem('/script-includes', 'book',     'Script includes',  'sys_script_include'),
    navItem('/ui-policies',     'shield',   'UI policies',      'sys_ui_policy'),
    navItem('/data-policies',   'lock',     'Data policies',    'sys_data_policy2'),
    navItem('/sla-definitions', 'history',  'SLA definitions',  'contract_sla'),
    navItem('/inbound-email-actions', 'arrow_right', 'Inbound email actions', 'sysevent_in_email_action'),
    navItem('/notifications',   'change',   'Notifications',    'sysevent_email_action'),
  ].filter(it => it !== null);
  const fmt = (n) => n >= 1000 ? Math.round(n/100)/10 + 'k' : n;
  const isActive = (id) => {
    if (id === '/') return route.view === 'home';
    if (id === '/service-catalog') return route.view === 'service_catalog_home';
    if (id === '/logic') return route.view === 'logic_home' || route.view === 'sn_table_inspector';
    if (id === '/cmdb') return route.view === 'cmdb_home';
    const map = {
      '/incidents': 'incident', '/changes': 'change_request',
      '/problems': 'problem', '/requests': 'sc_request',
      '/requested-items': 'sc_req_item', '/catalog-tasks': 'sc_task',
      '/catalog-items': 'sc_cat_item',
      '/group-approvals': 'sysapproval_group', '/asset-tasks': 'asset_task',
      '/contract-renewal-tasks': 'sn_contract_renewal_task',
      '/hardware': 'alm_hardware', '/licenses': 'alm_license',
      '/consumables': 'alm_consumable', '/facilities': 'alm_facility',
      '/facility-assets': 'sn_ent_facility_asset',
      '/stockrooms': 'alm_stockroom', '/assets': 'alm_asset',
      '/software': 'cmdb_ci_spkg', '/software-installs': 'cmdb_software_instance',
      '/users': 'sys_user', '/groups': 'sys_user_group',
      '/delegations': 'sys_user_delegate', '/knowledge': 'kb_knowledge', '/templates': 'sys_template', '/cis': 'cmdb_ci',
      '/business-rules': 'sys_script', '/client-scripts': 'sys_script_client',
      '/script-includes': 'sys_script_include', '/scheduled-jobs': 'sysauto_script',
      '/ui-policies': 'sys_ui_policy', '/data-policies': 'sys_data_policy2',
      '/sla-definitions': 'contract_sla',
      '/inbound-email-actions': 'sysevent_in_email_action', '/notifications': 'sysevent_email_action',
    };
    return map[id] && ((route.view === 'list' && route.table === map[id]) ||
           (route.view === 'record' && map[id] === route.table) ||
           (route.view?.startsWith('reference_') && (
             (id === '/users' && route.view === 'reference_user') ||
             (id === '/groups' && route.view === 'reference_group') ||
             (id === '/cis' && route.view === 'reference_ci')
           )));
  };

  // Adjust router for reference URL routes
  return (
    <nav className="sidebar">
      {items.map((it, i) => it.sep ? (
        <div key={i} className="section-label" style={{ marginTop: 8 }}>{it.sep}</div>
      ) : (
        <button key={it.id} className={'nav-item' + (isActive(it.id) ? ' active' : '')} onClick={() => window.navigate(it.id)}>
          <span className="icon"><window.Icon name={it.icon} size={14} /></span>
          <span>{it.label}</span>
          {it.count != null && <span className="count">{fmt(it.count)}</span>}
        </button>
      ))}
      <div style={{ marginTop: 'auto', padding: '14px 10px 4px' }}>
        <div style={{
          background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8,
          padding: 10, fontSize: 11.5, color: 'var(--fg-3)', lineHeight: 1.5,
        }}>
          <div style={{ fontWeight: 600, color: 'var(--fg-2)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
            <window.Icon name="archive" size={11} /> Archive only
          </div>
          No live ServiceNow connection. Records reflect the snapshot at left.
        </div>
      </div>
    </nav>
  );
}

function AuditLogPanel({ onClose }) {
  const entries = window.AuditLog.all();
  const who = window.HistoricalWowData.whoami || {};
  const label = who.host || who.ip || 'this browser';
  const sub = who.access_log
    ? 'session view; the server also records every request to its access log'
    : 'session view; server-side access log is disabled on this deployment';
  return (
    <div className="audit-log-overlay" onClick={onClose}>
      <div className="audit-log-panel" onClick={e => e.stopPropagation()}>
        <div className="head">
          <window.Icon name="history" size={14} />
          <h3>Your access log</h3>
          <span className="sub">{sub}</span>
          <button className="icon-btn close" onClick={onClose} style={{ width: 26, height: 26, display: 'grid', placeItems: 'center', borderRadius: 6 }}>
            <window.Icon name="close" size={14} />
          </button>
        </div>
        <div className="body">
          {entries.length === 0 && <div className="empty">No reads recorded yet this session.</div>}
          {entries.map((e, i) => (
            <div key={i} className="entry">
              <div className="when">{new Date(e.ts).toISOString().replace('T', ' ').slice(0, 19)} · {label}</div>
              <div className="what">
                {e.kind === 'view' ? 'opened ' : e.kind === 'list' ? 'listed ' : 'searched '}
                <span className="target mono">{e.target}</span>
                {e.label && <span style={{ color: 'var(--fg-3)' }}> — {e.label}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function WhoamiBadge({ whoami }) {
  // Server-seen identity. host is the reverse-DNS of the request's client
  // IP (cached server-side); ip is the raw source IP; both can be null if
  // the server couldn't resolve them or the access-log DNS lookup is off.
  const w = whoami || {};
  const primary = w.host || w.ip || 'unknown';
  const tip = w.access_log
    ? `Server sees ${w.host || '(no PTR)'} · ${w.ip || '(no IP)'}\nRequests are recorded to the access log.`
    : `Server sees ${w.host || '(no PTR)'} · ${w.ip || '(no IP)'}\nAccess log is disabled on this deployment.`;
  return (
    <div title={tip}
         style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px 0 4px', minWidth: 0 }}>
      <window.Avatar name={primary} size="sm" />
      <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
        {primary}
      </span>
    </div>
  );
}

// Patch route to handle reference pages (users/:id etc.) — already covered by record view names
// Override router behavior: users/:id → reference_user etc.
const _origParse = window.useRoute;
// Monkey-patch the parser by overriding navigation results for reference URLs
const _origUseRoute = window.useRoute;
window.useRoute = function () {
  const [r, nav] = _origUseRoute();
  // Translate /users/:id etc. to reference views
  if (r.view === 'record') {
    if (r.table === 'sys_user')        return [{ ...r, view: 'reference_user' }, nav];
    if (r.table === 'sys_user_group')  return [{ ...r, view: 'reference_group' }, nav];
    if (r.table === 'cmdb_ci')         return [{ ...r, view: 'reference_ci' }, nav];
  }
  return [r, nav];
};

// --- HR gate UI ----------------------------------------------------------
// HR-restricted incidents (assignment_group == HR_GROUP_SYS_ID on the
// server) are filtered out of every API response unless the browser holds
// the hr_unlock cookie set by POST /api/hr-unlock with the right password.
// The button below shows current state; clicking it opens the modal (locked)
// or POSTs /api/hr-lock and reloads (unlocked).

function HrGateButton({ status, onUnlockClick, onLockClick }) {
  const unlocked = status.unlocked;
  const label = status.group_label || 'HR';
  return (
    <button
      className={'toggle' + (unlocked ? ' on' : '')}
      onClick={unlocked ? onLockClick : onUnlockClick}
      title={unlocked
        ? `${label} data is unlocked for this browser — click to lock again`
        : `${label} data is hidden — click to unlock`}
      style={{
        gap: 6,
        background: unlocked ? 'oklch(28% 0.055 145)' : undefined,
        borderColor: unlocked ? 'oklch(42% 0.090 145)' : undefined,
        color: unlocked ? 'oklch(82% 0.11 145)' : undefined,
      }}
    >
      <window.Icon name={unlocked ? 'unlock' : 'lock'} size={13} />
      <span>{unlocked ? 'HR data unlocked' : 'Unlock HR data'}</span>
    </button>
  );
}

function HrUnlockModal({ status, onClose, onSuccess }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = React.useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (e) => {
    e?.preventDefault?.();
    if (!pw || busy) return;
    setBusy(true); setErr('');
    try {
      await window.HistoricalWowData.unlockHr(pw);
      onSuccess();
    } catch (e) {
      setErr(e.message === 'wrong password' ? 'Wrong password.' : `Failed: ${e.message}`);
      setBusy(false);
    }
  };

  return (
    <div className="audit-log-overlay" onClick={onClose} style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--bg-elev)', border: '1px solid var(--border-2)', borderRadius: 12,
        boxShadow: 'var(--shadow-lg)', padding: 24, width: 'min(420px, 92vw)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <window.Icon name="lock" size={16} />
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Unlock HR data</h3>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--fg-3)', lineHeight: 1.55, marginBottom: 16 }}>
          Incidents assigned to <strong>{status.group_label}</strong> are hidden from this archive
          by default. Enter the access password to include them in lists, search, and the record view.
          The unlock applies to this browser only and clears when you lock or close the browser.
        </div>
        <form onSubmit={submit}>
          <input
            ref={inputRef}
            type="password"
            value={pw}
            onChange={e => { setPw(e.target.value); setErr(''); }}
            placeholder="HR access password"
            autoComplete="off"
            disabled={busy}
            style={{
              width: '100%', padding: '10px 12px', fontSize: 13.5,
              border: '1px solid var(--border-2)', borderRadius: 8,
              fontFamily: 'var(--font-sans)', background: 'var(--bg)',
            }}
          />
          {err && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--c-red)' }}>{err}</div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="toggle"
              style={{ padding: '6px 14px' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !pw}
              className="toggle on"
              style={{ padding: '6px 14px', opacity: (busy || !pw) ? 0.5 : 1 }}
            >
              {busy ? 'Unlocking…' : 'Unlock'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
