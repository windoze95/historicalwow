/* eslint-disable */
// HistoricalWow data layer.
//
// Architecture: this is a thin async API client, NOT a "load everything into
// memory" cache. The viewer fetches what each view needs, when the view needs
// it. Only small reference tables get eager-loaded so component code can do
// synchronous lookups (window.findUser, decodeChoice, etc.).
//
// What's critical (blocks UI render — all small, parallel, gzipped):
//   sys_choice, core_company, cmn_department, cmn_location, cmn_cost_center,
//   sys_user_group, sys_user_grmember, manifest, hr_status.
//
// What's background (loads after `ready=true`; components fall back to
// the envelope's __display_<field> until the map arrives):
//   sys_user_lookup (sys_id → {name, user_name, title, …}, ~5 MB gz),
//   cmdb_ci_lookup  (sys_id → {name, sys_class_name, …},  ~33 MB gz).
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
  // and to drive bucketTaskRecordsAsync's display order on the group page.
  // Catalog flow ordered SCTASK → RITM → REQ (richer detail first) to match
  // the user-page USER_TABLE_ORDER convention.
  window.TASK_TABLES = [
    'incident', 'change_request', 'problem', 'problem_task',
    'sc_task', 'sc_req_item', 'sc_request',
    'incident_task', 'change_task',
    'sysapproval_group', 'asset_task',
    'sn_contract_renewal_task',
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
    // Caller identity-by-network-position, populated by /api/whoami on boot.
    // There is no auth in front of this service; `host` is the server's
    // reverse-DNS lookup of the request's client IP (best-effort, cached
    // server-side), `ip` is the raw client IP, and `access_log` reports
    // whether the server is recording requests to its rotating log file.
    whoami: { ip: null, host: null, access_log: false },
    loadStatus: {
      ready: false, source: null, table: null,
      // Critical jobs the loading screen blocks on: manifest + EAGER_TABLES
      // + hr_status + whoami. The two big lookup maps (sys_user_lookup,
      // cmdb_ci_lookup — together 38 MB gzipped) load in the background
      // after `ready=true` so they don't block the UI on slow networks.
      total: EAGER_TABLES.length + 3,
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

  // ---- IndexedDB cache --------------------------------------------------
  // Lookup maps are deterministic functions of the snapshot — the same
  // input (manifest.captured_at) always produces the same output. So we
  // store them in IndexedDB keyed on the snapshot id, and only refetch
  // when the snapshot changes (i.e. when a new export was ingested
  // server-side). For 33 MB cmdb_ci_lookup over a slow VPN, this cuts
  // repeat-visit boot time from "stream + parse 33 MB" to "open IDB,
  // structured-clone-deserialize directly into a Map" — typically
  // 100-500 ms vs 5-30 s.
  const IDB_NAME = 'historicalwow';
  const IDB_STORE = 'lookups';

  function openIDB() {
    return new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(IDB_STORE)) {
            req.result.createObjectStore(IDB_STORE);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      } catch (e) { reject(e); }
    });
  }

  function idbGet(db, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbPut(db, key, value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const req = tx.objectStore(IDB_STORE).put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // Fetch-with-IDB-cache. snapshotId comes from manifest.captured_at;
  // if the stored entry's snapshotId matches, return it immediately and
  // skip the network entirely. Otherwise fetch fresh and overwrite.
  async function fetchWithIdbCache(key, snapshotId, fetcher) {
    let db;
    try { db = await openIDB(); } catch (e) {
      console.warn(`[historicalwow] IDB open failed (${e.message}); falling back to network for ${key}`);
      return fetcher();
    }
    try {
      const stored = await idbGet(db, key);
      if (stored && stored.snapshotId === snapshotId && stored.value) {
        return stored.value;
      }
    } catch (e) {
      console.warn(`[historicalwow] IDB read failed for ${key}; refetching:`, e.message);
    }
    const value = await fetcher();
    try {
      await idbPut(db, key, { snapshotId, value });
    } catch (e) {
      console.warn(`[historicalwow] IDB write failed for ${key} (cache disabled this session):`, e.message);
    }
    return value;
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
  data.fetchSlaStats = async function (kind, sys_id) {
    return apiGet(`/api/sla-stats/${kind}/${sys_id}`);
  };
  data.fetchAuditFor = async function (sys_id) {
    const res = await apiGet(`/api/audit/${sys_id}`);
    return (res.rows || []).map(flatten);
  };
  data.fetchAttachmentsFor = async function (sys_id) {
    const res = await apiGet(`/api/attachments/${sys_id}`);
    return (res.rows || []).map(flatten);
  };
  data.fetchVariables = async function (ritm_sys_id) {
    const res = await apiGet(`/api/variables/${ritm_sys_id}`);
    return { rows: res.rows || [], cat_item: res.cat_item || null };
  };
  data.fetchCIRelations = async function (sys_id) {
    const res = await apiGet(`/api/related/cmdb/${sys_id}`);
    // CIRefPage reads each item as { rel, ci }. The endpoint returns the
    // relationship row's fields at the top level plus a `ci` envelope (absent
    // when the parent/child sys_id is a dangling endpoint — a rel pointing at
    // a CI not in this snapshot). Nest the rel under `rel` (so `u.rel.type`
    // resolves, not undefined) and drop rows whose CI didn't resolve (so
    // `u.ci.name` never dereferences null). Either of those was an uncaught
    // throw that blanked the whole page once relations loaded.
    const shape = (arr) => (arr || [])
      .map(r => { const { ci, ...rel } = r; return { rel: flatten(rel), ci: ci ? flatten(ci) : null }; })
      .filter(x => x.ci);
    return { upstream: shape(res.upstream), downstream: shape(res.downstream) };
  };
  // CMDB overview aggregates (class/status/discovery/staleness/ownership/
  // relationships) + the indexed-column set the CI-list filters feature-detect
  // against. NOT IDB-cached: the payload is small (a few KB gzipped) and it's
  // schema-dependent — a column-only rebuild changes `indexed_columns` without
  // changing manifest.captured_at, so a captured_at-keyed IDB entry would pin
  // stale results and the new filters would never appear. The server already
  // caches it in memory (keyed on db mtime) and serves it with an ETag +
  // short max-age, so a plain fetch is cheap and self-healing.
  data.fetchCmdbMetrics = async function () {
    return apiGet('/api/cmdb/metrics');
  };

  // Indexed task-table distributions for the analytics page and list facets.
  // The server applies the same HR visibility rule as /api/<table> and returns
  // `indexed_columns` so an older DB never exposes a filter it cannot honor.
  data.fetchTaskMetrics = async function (table) {
    return apiGet(`/api/task/metrics/${encodeURIComponent(table)}`);
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

  // Critical jobs — block UI render. Small reference data + manifest +
  // hr_status. All firing in parallel; total is bounded by the slowest
  // single fetch (~few hundred KB compressed each).
  function makeCriticalJobs() {
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
    jobs.push(['hr_status', async () => {
      try {
        data.hrStatus = await apiGet('/api/hr-status');
      } catch (e) {
        console.warn('[historicalwow] hr-status failed:', e.message);
      }
    }]);
    jobs.push(['whoami', async () => {
      try {
        data.whoami = await apiGet('/api/whoami');
      } catch (e) {
        console.warn('[historicalwow] whoami failed:', e.message);
      }
    }]);
    return jobs;
  }

  // Background jobs — fire after `ready=true`. Components that depend on
  // these (UserCell, RefLink kind=ci) gracefully fall back to the
  // envelope's __display_<field> until the lookup map arrives, so the
  // page renders immediately and progressively enhances.
  //
  // Both lookups go through IDB cache. Within a snapshot, the second
  // visit (and every visit after) skips the network entirely — IDB
  // hands back the parsed object via structured clone in a few hundred
  // ms instead of streaming + parsing 38 MB of gzipped JSON.
  function loadBackgroundLookups() {
    const snapshotId = (data.manifest && data.manifest.captured_at) || 'unknown';
    fetchWithIdbCache('sys_user_lookup', snapshotId, () => apiGet('/api/sys_user_lookup'))
      .then(map => { data.sys_user_lookup = new Map(Object.entries(map)); notify(); })
      .catch(e => console.warn('[historicalwow] sys_user_lookup failed:', e.message));
    fetchWithIdbCache('cmdb_ci_lookup', snapshotId, () => apiGet('/api/cmdb_ci_lookup'))
      .then(map => { data.cmdb_ci_lookup = new Map(Object.entries(map)); notify(); })
      .catch(e => console.warn('[historicalwow] cmdb_ci_lookup failed:', e.message));
  }

  async function loadAll() {
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

    const jobs = makeCriticalJobs();
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
    // Kick off the heavy lookups now that the UI is unblocked. They'll
    // notify subscribers individually as they finish.
    loadBackgroundLookups();
  }

  data.ready = loadAll();
  return data;
})();
