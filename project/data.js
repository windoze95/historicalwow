/* eslint-disable */
// HistoricalWow data layer.
//
// Eagerly loads small/medium tables from /api/* into memory at startup so
// existing components can keep doing synchronous lookups (window.findUser,
// data.changes.filter, etc.). Tables too big for memory expose async helpers
// instead — the viewer fetches per-record / paginated batches on demand.
//
// Eager (slim — indexed cols only):
//   incident, cmdb_ci          (~85 MB and ~100 MB respectively for slim cols)
//
// Eager (full):
//   sys_user, sys_user_group, sys_user_grmember,
//   change_request, problem, problem_task, sc_request, sc_req_item, sc_task,
//   incident_task, change_task, sysapproval_group, asset_task,
//   task_ci, task_sla, sysapproval_approver,
//   sys_choice, core_company, cmn_department, cmn_location, cmn_cost_center
//
// Lazy (never eager-loaded):
//   sys_audit, sys_journal_field, cmdb_rel_ci, sys_attachment, full incident,
//   full cmdb_ci. Components fetch via data.fetch* helpers when needed.

window.HistoricalWowData = (function () {
  // [<servicenow table name>, <key on window.HistoricalWowData>, <slim?>]
  const EAGER_TABLES = [
    // Reference (small)
    ['sys_choice',          'sys_choice',           false],
    ['core_company',        'companies',            false],
    ['cmn_department',      'departments',          false],
    ['cmn_location',        'locations',            false],
    ['cmn_cost_center',     'cost_centers',         false],
    // Identity
    ['sys_user',            'sys_user',             false],
    ['sys_user_group',      'sys_user_group',       false],
    ['sys_user_grmember',   'sys_user_grmember',    false],
    // CMDB — slim (only key fields, ~100 bytes/record × 1M = ~100 MB)
    ['cmdb_ci',             'cmdb_ci',              true],
    // Task records — change_request and friends are small enough to fully load
    ['change_request',      'changes',              false],
    ['problem',             'problem',              false],
    ['problem_task',        'problem_task',         false],
    ['sc_request',          'sc_request',           false],
    ['sc_req_item',         'sc_req_item',          false],
    ['sc_task',             'sc_task',              false],
    ['incident_task',       'incident_task',        false],
    ['change_task',         'change_task',          false],
    ['sysapproval_group',   'sysapproval_group',    false],
    ['asset_task',          'asset_task',           false],
    // incident — slim (424k records × ~200 bytes = ~85 MB). Full record fetched on-demand.
    ['incident',            'incidents',            true],
    // Task relationships
    ['task_ci',             'task_ci',              false],
    ['task_sla',             'task_sla',            false],
    ['sysapproval_approver','sysapproval_approver', false],
  ];

  // Mirrors the exporter — used by UI code to inspect "is this a task table?"
  window.TASK_TABLES = [
    'incident', 'change_request', 'problem', 'problem_task',
    'sc_request', 'sc_req_item', 'sc_task',
    'incident_task', 'change_task',
    'sysapproval_group', 'asset_task',
  ];

  const data = {
    // Initialize empty so existing readers don't crash before load completes.
    companies: [], departments: [], locations: [], cost_centers: [],
    sys_user: [], sys_user_group: [], sys_user_grmember: [],
    cmdb_ci: [],
    sys_choice: [],
    incidents: [], changes: [],
    problem: [], problem_task: [],
    sc_request: [], sc_req_item: [], sc_task: [],
    incident_task: [], change_task: [],
    sysapproval_group: [], asset_task: [],
    task_ci: [], task_sla: [], sysapproval_approver: [],
    // Lazy tables — empty arrays for backward compatibility with components
    // that filter them; they'll never have content. Use the fetch* helpers.
    cmdb_rel_ci: [],
    journal: [],
    audit: [],
    attachments: [],
    manifest: {
      label: 'loading…', snapshot_date: '', instance: '', captured_at: '',
      tables: [], integrity: { sha256_manifest: '', acl_skips: 0, missing_attachments: 0 },
    },
    loadStatus: {
      ready: false, source: null, table: null,
      total: EAGER_TABLES.length + 1,  // +1 for manifest
      loaded: 0,
      error: null,
    },
  };

  // Subscriber pattern so the React shell can re-render as load progresses.
  const listeners = new Set();
  data.subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const notify = () => { for (const fn of listeners) { try { fn(data); } catch (_) {} } };

  // Flatten ServiceNow's {value, display_value} envelope to plain values, with
  // __display_<key> for fields whose display value differs. Coerces 'true'/
  // 'false' boolean strings.
  function flatten(row) {
    if (!row) return row;
    const out = {};
    for (const k in row) {
      const v = row[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v) {
        let val = v.value;
        if (val === 'true') val = true;
        else if (val === 'false') val = false;
        out[k] = val;
        if (v.display_value != null && v.display_value !== v.value) {
          out['__display_' + k] = v.display_value;
        }
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  // Lightweight retry wrapper around fetch — single transient retry to soak
  // up the inevitable network blip during load.
  async function apiGet(path) {
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(path);
        if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
        return await res.json();
      } catch (e) {
        lastErr = e;
        if (attempt === 0) await new Promise(r => setTimeout(r, 250));
      }
    }
    throw lastErr;
  }
  data.apiGet = apiGet;

  // ---- async helpers exposed to React components --------------------------

  // Single record (full envelope, all fields).
  data.fetchRecord = async function (table, sys_id) {
    const row = await apiGet(`/api/${table}/${sys_id}`);
    return flatten(row);
  };

  // Paginated list. opts: { limit, offset, q, filters: {col: val}, order_by, dir, slim }.
  data.fetchTaskList = async function (table, opts = {}) {
    const params = new URLSearchParams();
    if (opts.limit) params.set('limit', opts.limit);
    if (opts.offset) params.set('offset', opts.offset);
    if (opts.q) params.set('q', opts.q);
    if (opts.order_by) params.set('order_by', opts.order_by);
    if (opts.dir) params.set('dir', opts.dir);
    if (opts.slim) params.set('slim', '1');
    if (opts.filters) {
      for (const [k, v] of Object.entries(opts.filters)) {
        if (v != null && v !== '') params.set(k, v);
      }
    }
    const res = await apiGet(`/api/${table}?${params}`);
    return { ...res, rows: (res.rows || []).map(flatten) };
  };

  data.fetchJournalFor = async function (sys_id) {
    const res = await apiGet(`/api/journal/${sys_id}`);
    return (res.rows || []).map(flatten);
  };
  data.fetchAuditFor = async function (sys_id) {
    const res = await apiGet(`/api/audit/${sys_id}`);
    return (res.rows || []).map(flatten);
  };
  data.fetchAttachmentsFor = async function (sys_id) {
    const res = await apiGet(`/api/attachments/${sys_id}`);
    return (res.rows || []).map(flatten);
  };
  data.fetchCIRelations = async function (sys_id) {
    const res = await apiGet(`/api/related/cmdb/${sys_id}`);
    return {
      upstream:   (res.upstream   || []).map(r => ({ ...flatten(r), ci: flatten(r.ci) })),
      downstream: (res.downstream || []).map(r => ({ ...flatten(r), ci: flatten(r.ci) })),
    };
  };
  data.fetchSearch = async function (q, types) {
    const params = new URLSearchParams({ q });
    if (types && types.length) params.set('types', types.join(','));
    const res = await apiGet(`/api/search?${params}`);
    return (res.rows || []).map(r => ({ ...flatten(r), _table: r._table }));
  };

  // ---- post-load processing for eager data --------------------------------

  function postProcess() {
    // sys_choice: alias `name` → `table` for the viewer's decodeChoice() lookup.
    for (const c of data.sys_choice) {
      if (!c.table && c.name) c.table = c.name;
    }
    // Group membership: derive g.member_sys_ids from sys_user_grmember pivot.
    const groupMembers = new Map();
    for (const m of data.sys_user_grmember) {
      const g = m.group, u = m.user;
      if (!g || !u) continue;
      let arr = groupMembers.get(g);
      if (!arr) { arr = []; groupMembers.set(g, arr); }
      arr.push(u);
    }
    for (const g of data.sys_user_group) {
      if (!g.member_sys_ids) g.member_sys_ids = groupMembers.get(g.sys_id) || [];
    }
  }

  // ---- load orchestration ------------------------------------------------

  async function loadAll() {
    // Manifest first
    data.loadStatus.table = 'manifest';
    notify();
    try {
      data.manifest = await apiGet('/api/manifest');
      data.loadStatus.source = 'export';
    } catch (e) {
      console.warn('[historicalwow] /api/manifest failed:', e.message);
      data.loadStatus.error = e.message;
      data.loadStatus.ready = true;
      notify();
      return;
    }
    data.loadStatus.loaded += 1;
    notify();

    // Eager tables — sequential to keep the progress display sensible.
    for (const [table, alias, slim] of EAGER_TABLES) {
      data.loadStatus.table = table;
      notify();
      try {
        const params = new URLSearchParams({
          limit: '2000000', offset: '0',
        });
        if (slim) params.set('slim', '1');
        const res = await apiGet(`/api/${table}?${params}`);
        data[alias] = (res.rows || []).map(flatten);
      } catch (e) {
        console.warn(`[historicalwow] eager-load ${table} failed:`, e.message);
        data[alias] = [];
      }
      data.loadStatus.loaded += 1;
      notify();
    }

    postProcess();
    data.loadStatus.table = null;
    data.loadStatus.ready = true;
    notify();
  }

  data.ready = loadAll();
  return data;
})();
