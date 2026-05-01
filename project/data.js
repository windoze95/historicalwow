/* eslint-disable */
// HistoricalWow data layer.
//
// Architecture: this is a thin async API client, NOT a "load everything into
// memory" cache. The viewer fetches what each view needs, when the view needs
// it. Only small reference tables get eager-loaded so component code can do
// synchronous lookups (window.findUser, decodeChoice, etc.).
//
// What's eager (small, ~10 MB compressed combined, cached 5 min on browser):
//   sys_choice, core_company, cmn_department, cmn_location, cmn_cost_center,
//   sys_user (~5 MB gzipped), sys_user_group, sys_user_grmember,
//   change_request, problem, problem_task, sc_request, sc_req_item, sc_task,
//   incident_task, change_task, sysapproval_group, asset_task,
//   task_ci, task_sla, sysapproval_approver,
//   AND cmdb_ci_lookup (~3-5 MB compressed map of sys_id → name/class)
//
// What's lazy (fetched per view via API helpers):
//   incident (424k records — list views paginate, refs filter)
//   full cmdb_ci record (CIRefPage detail)
//   sys_audit, sys_journal_field (per-record on tab open)
//   sys_attachment metadata (per-record)
//   cmdb_rel_ci (per-CI on CIRefPage)

window.HistoricalWowData = (function () {
  // [<servicenow table name>, <key on window.HistoricalWowData>]
  const EAGER_TABLES = [
    ['sys_choice',          'sys_choice'],
    ['core_company',        'companies'],
    ['cmn_department',      'departments'],
    ['cmn_location',        'locations'],
    ['cmn_cost_center',     'cost_centers'],
    ['sys_user',            'sys_user'],
    ['sys_user_group',      'sys_user_group'],
    ['sys_user_grmember',   'sys_user_grmember'],
    ['change_request',      'changes'],
    ['problem',             'problem'],
    ['problem_task',        'problem_task'],
    ['sc_request',          'sc_request'],
    ['sc_req_item',         'sc_req_item'],
    ['sc_task',             'sc_task'],
    ['incident_task',       'incident_task'],
    ['change_task',         'change_task'],
    ['sysapproval_group',   'sysapproval_group'],
    ['asset_task',          'asset_task'],
    ['task_ci',             'task_ci'],
    ['task_sla',            'task_sla'],
    ['sysapproval_approver','sysapproval_approver'],
  ];

  // Mirrors the exporter — used by UI code to inspect "is this a task table?"
  window.TASK_TABLES = [
    'incident', 'change_request', 'problem', 'problem_task',
    'sc_request', 'sc_req_item', 'sc_task',
    'incident_task', 'change_task',
    'sysapproval_group', 'asset_task',
  ];

  const data = {
    // Eagerly loaded (or empty until ready)
    companies: [], departments: [], locations: [], cost_centers: [],
    sys_user: [], sys_user_group: [], sys_user_grmember: [],
    sys_choice: [],
    changes: [],
    problem: [], problem_task: [],
    sc_request: [], sc_req_item: [], sc_task: [],
    incident_task: [], change_task: [],
    sysapproval_group: [], asset_task: [],
    task_ci: [], task_sla: [], sysapproval_approver: [],
    // CMDB CI lookup map: sys_id → { name, sys_class_name, operational_status }
    // Eagerly loaded (~5 MB gzipped). Full CI record fetched on demand.
    cmdb_ci_lookup: new Map(),
    // Lazy (always empty, components use fetch* helpers):
    cmdb_ci: [],         // legacy compat — components should use cmdb_ci_lookup or fetchRecord
    cmdb_rel_ci: [],
    incidents: [],
    journal: [],
    audit: [],
    attachments: [],
    manifest: {
      label: 'loading…', snapshot_date: '', instance: '', captured_at: '',
      tables: [], integrity: { sha256_manifest: '', acl_skips: 0, missing_attachments: 0 },
    },
    loadStatus: {
      ready: false, source: null, table: null,
      total: EAGER_TABLES.length + 2,  // +manifest +cmdb_ci_lookup
      loaded: 0,
      error: null,
    },
  };

  // Subscriber pattern for re-render on load progress.
  const listeners = new Set();
  data.subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const notify = () => { for (const fn of listeners) { try { fn(data); } catch (_) {} } };

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

  data.fetchRecord = async function (table, sys_id) {
    return flatten(await apiGet(`/api/${table}/${sys_id}`));
  };

  // Paginated list. opts: { limit, offset, q, filters, order_by, dir, slim }.
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

  // ---- post-load processing ----------------------------------------------

  function postProcess() {
    for (const c of data.sys_choice) {
      if (!c.table && c.name) c.table = c.name;
    }
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

    // Eager tables
    for (const [table, alias] of EAGER_TABLES) {
      data.loadStatus.table = table;
      notify();
      try {
        const res = await apiGet(`/api/${table}?limit=2000000&offset=0`);
        data[alias] = (res.rows || []).map(flatten);
      } catch (e) {
        console.warn(`[historicalwow] ${table} eager-load failed:`, e.message);
        data[alias] = [];
      }
      data.loadStatus.loaded += 1;
      notify();
    }

    // CMDB CI lookup map (compact: sys_id → name/class/status)
    data.loadStatus.table = 'cmdb_ci_lookup';
    notify();
    try {
      const map = await apiGet('/api/cmdb_ci_lookup');
      data.cmdb_ci_lookup = new Map(Object.entries(map));
    } catch (e) {
      console.warn('[historicalwow] cmdb_ci_lookup failed:', e.message);
      data.cmdb_ci_lookup = new Map();
    }
    data.loadStatus.loaded += 1;
    notify();

    postProcess();
    data.loadStatus.table = null;
    data.loadStatus.ready = true;
    notify();
  }

  data.ready = loadAll();
  return data;
})();
