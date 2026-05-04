/* eslint-disable */
// HistoricalWow data layer.
//
// Architecture: this is a thin async API client, NOT a "load everything into
// memory" cache. The viewer fetches what each view needs, when the view needs
// it. Only small reference tables get eager-loaded so component code can do
// synchronous lookups (window.findUser, decodeChoice, etc.).
//
// What's eager (all fired in parallel on boot, gzipped, cached 5 min):
//   sys_choice, core_company, cmn_department, cmn_location, cmn_cost_center,
//   sys_user_group, sys_user_grmember,
//   sys_user_lookup (sys_id → {name, user_name, title, …} compact map),
//   cmdb_ci_lookup  (sys_id → {name, sys_class_name, …}    compact map).
//
// What's lazy (fetched per view via API helpers):
//   every task table (incident, change_request, problem, sc_request, …)
//   full sys_user / cmdb_ci records (UserRefPage / CIRefPage detail)
//   sys_audit, sys_journal_field (per-record on tab open)
//   sys_attachment metadata (per-record)
//   cmdb_rel_ci (per-CI on CIRefPage)

window.HistoricalWowData = (function () {
  // Tables eager-loaded ONLY because the JSX uses them in synchronous lookups
  // (findCI, findGroup, decodeChoice, etc.) and they're small enough to keep
  // in memory. Anything bigger is fetched per-view via API.
  const EAGER_TABLES = [
    ['sys_choice',          'sys_choice'],     // decodeChoice
    ['core_company',        'companies'],      // findCompany
    ['cmn_department',      'departments'],    // findDepartment
    ['cmn_location',        'locations'],      // findLocation
    ['cmn_cost_center',     'cost_centers'],   // findCostCenter
    ['sys_user_group',      'sys_user_group'], // findGroup (~200 records)
    ['sys_user_grmember',   'sys_user_grmember'], // group membership pivot (small)
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
    sys_user_group: [], sys_user_grmember: [],
    sys_choice: [],
    // Lookup maps — compact projections used by sync find* helpers.
    cmdb_ci_lookup: new Map(),  // sys_id → { name, sys_class_name, operational_status }
    sys_user_lookup: new Map(), // sys_id → { name, user_name, title, department, location }
    // Lazy: components fetch what they need via the API helpers below.
    sys_user: [],         // populated only by callers that need full envelope (rare)
    cmdb_ci: [],          // legacy compat — empty
    cmdb_rel_ci: [],
    incidents: [], changes: [],
    problem: [], problem_task: [],
    sc_request: [], sc_req_item: [], sc_task: [],
    incident_task: [], change_task: [],
    sysapproval_group: [], asset_task: [],
    task_ci: [], task_sla: [], sysapproval_approver: [],
    journal: [],
    audit: [],
    attachments: [],
    manifest: {
      label: 'loading…', snapshot_date: '', instance: '', captured_at: '',
      tables: [], integrity: { sha256_manifest: '', acl_skips: 0, missing_attachments: 0 },
    },
    // HR gate — populated by /api/hr-status on boot. enabled=true means the
    // server is filtering HR-assigned incidents on locked sessions; the
    // viewer surfaces an unlock button when so.
    hrStatus: { enabled: false, unlocked: false, group_sys_id: '', group_label: '' },
    loadStatus: {
      ready: false, source: null, table: null,
      total: EAGER_TABLES.length + 4,  // +manifest +cmdb_ci_lookup +sys_user_lookup +hr_status
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

  // HR gate
  data.fetchHrStatus = async function () {
    const s = await apiGet('/api/hr-status');
    data.hrStatus = s;
    notify();
    return s;
  };
  data.unlockHr = async function (password) {
    const res = await fetch('/api/hr-unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    data.hrStatus = { ...data.hrStatus, unlocked: true };
    notify();
    return true;
  };
  data.lockHr = async function () {
    await fetch('/api/hr-lock', { method: 'POST', credentials: 'same-origin' });
    data.hrStatus = { ...data.hrStatus, unlocked: false };
    notify();
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

  // One job = (label, work-fn). All jobs after manifest run in parallel via
  // Promise.allSettled — boot is bounded by the slowest single fetch
  // (typically cmdb_ci_lookup), not the sum of all of them.
  function makeJobs() {
    const jobs = [];
    for (const [table, alias] of EAGER_TABLES) {
      jobs.push([table, async () => {
        try {
          const res = await apiGet(`/api/${table}?limit=2000000&offset=0`);
          data[alias] = (res.rows || []).map(flatten);
        } catch (e) {
          console.warn(`[historicalwow] ${table} eager-load failed:`, e.message);
          data[alias] = [];
        }
      }]);
    }
    jobs.push(['sys_user_lookup', async () => {
      try {
        const map = await apiGet('/api/sys_user_lookup');
        data.sys_user_lookup = new Map(Object.entries(map));
      } catch (e) {
        console.warn('[historicalwow] sys_user_lookup failed:', e.message);
        data.sys_user_lookup = new Map();
      }
    }]);
    jobs.push(['cmdb_ci_lookup', async () => {
      try {
        const map = await apiGet('/api/cmdb_ci_lookup');
        data.cmdb_ci_lookup = new Map(Object.entries(map));
      } catch (e) {
        console.warn('[historicalwow] cmdb_ci_lookup failed:', e.message);
        data.cmdb_ci_lookup = new Map();
      }
    }]);
    jobs.push(['hr_status', async () => {
      try {
        data.hrStatus = await apiGet('/api/hr-status');
      } catch (e) {
        console.warn('[historicalwow] hr-status failed:', e.message);
      }
    }]);
    return jobs;
  }

  async function loadAll() {
    // Manifest fires in parallel with everything else — nothing in the load
    // path depends on manifest data, only the loading-screen label does.
    data.loadStatus.table = 'manifest';
    notify();
    const manifestP = apiGet('/api/manifest').then(m => {
      data.manifest = m;
      data.loadStatus.source = 'export';
    }).catch(e => {
      console.warn('[historicalwow] /api/manifest failed:', e.message);
      data.loadStatus.error = e.message;
    }).finally(() => {
      data.loadStatus.loaded += 1;
      notify();
    });

    const jobs = makeJobs();
    await Promise.allSettled([
      manifestP,
      ...jobs.map(([label, fn]) => fn().finally(() => {
        data.loadStatus.loaded += 1;
        data.loadStatus.table = label;
        notify();
      })),
    ]);

    postProcess();
    data.loadStatus.table = null;
    data.loadStatus.ready = true;
    notify();
  }

  data.ready = loadAll();
  return data;
})();
