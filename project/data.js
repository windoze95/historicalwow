/* eslint-disable */
// HistoricalWow data layer.
// Loads NDJSON exports from ./data/ if present (run export/historicalwow_export.py
// to generate them). Falls back to the in-memory mock seed (data-mock.js)
// when no exports are available — useful for opening HistoricalWow.html directly
// without a server.

window.HistoricalWowData = (function () {
  // All task descendants the exporter pulls. Mirror of TASK_TABLES in
  // export/historicalwow_export.py — keep in sync if the exporter discovers
  // new task subclasses on the source instance.
  const TASK_TABLES = [
    'alm_transfer_order_line_subtask', 'alm_transfer_order_line_task',
    'asset_reclamation_request', 'asset_task', 'business_app_request',
    'cert_follow_on_task', 'cert_task', 'change_phase', 'change_request',
    'change_request_imac', 'change_task', 'chat_queue_entry',
    'cmdb_ci_exception', 'cmdb_data_management_task',
    'cmdb_multisource_recomp_task', 'comm_task', 'em_ci_severity_task',
    'em_remediation_task', 'gsw_task', 'help_guidance_task', 'incident',
    'incident_alert_task', 'incident_task', 'kb_feedback_task',
    'kb_knowledge_base_request', 'kb_submission', 'orphan_ci_remediation',
    'planned_task', 'problem', 'problem_task', 'reclassification_task',
    'recommended_field_remediation', 'reconcile_duplicate_task',
    'release_phase', 'release_task', 'required_field_remediation',
    'rm_defect', 'rm_doc', 'rm_enhancement', 'rm_epic', 'rm_feature',
    'rm_release', 'rm_release_scrum', 'rm_release_sdlc', 'rm_scrum_task',
    'rm_sprint', 'rm_story', 'rm_task', 'rm_test',
    'roster_schedule_span_proposal', 'sa_error_handler_task',
    'sam_saas_playbook_task', 'samp_asset_reclaim_task', 'samp_sp_vb_task',
    'samp_success_activity', 'samp_sw_eol_request', 'samp_sw_eol_task',
    'samp_sw_reclamation_candidate', 'sc_req_item', 'sc_request', 'sc_task',
    'scan_task', 'service_process_task', 'service_task',
    'sn_cmdb_int_util_ip_address_management_task', 'sn_contract_renewal_task',
    'sn_deploy_pipeline_deployment_request',
    'sn_itam_common_asset_onboarding_task',
    'sn_itam_common_loaner_asset_order', 'sn_itam_ztr_fulfillment_req',
    'sn_sforce_v2_spoke_case', 'stale_ci_remediation',
    'statemgmt_renew_lease_task', 'std_change_proposal', 'success_activity',
    'sys_report_access_request', 'sysapproval_group', 'ticket',
    'u_scheduled_task_run', 'upgrade_history_task', 'vtb_task',
  ];
  // Expose for the UI layer to inspect ("is this a task table?")
  window.TASK_TABLES = TASK_TABLES;

  // Aliases for the two record types the original viewer was built around;
  // every other task table is keyed by its ServiceNow name.
  const TASK_ALIAS = { incident: 'incidents', change_request: 'changes' };
  const taskEntries = TASK_TABLES.map((t) => [t, TASK_ALIAS[t] || t]);

  // [<servicenow table name>, <key on window.HistoricalWowData>]
  const TABLES = [
    ['sys_choice',           'sys_choice'],
    ['core_company',         'companies'],
    ['cmn_department',       'departments'],
    ['cmn_location',         'locations'],
    ['cmn_cost_center',      'cost_centers'],
    ['sys_user',             'sys_user'],
    ['sys_user_group',       'sys_user_group'],
    ['sys_user_grmember',    'sys_user_grmember'],
    ['cmdb_ci',              'cmdb_ci'],
    ['cmdb_rel_ci',          'cmdb_rel_ci'],
    ...taskEntries,
    ['task_ci',              'task_ci'],
    ['task_sla',             'task_sla'],
    ['sysapproval_approver', 'sysapproval_approver'],
    ['sys_journal_field',    'journal'],
    ['sys_audit',            'audit'],
    ['sys_attachment',       'attachments'],
  ];

  const data = {
    // Initialize empty so existing readers don't crash before load completes.
    companies: [], departments: [], locations: [], cost_centers: [],
    sys_user: [], sys_user_group: [], sys_user_grmember: [],
    cmdb_ci: [], cmdb_rel_ci: [],
    sys_choice: [],
    incidents: [], changes: [],
    task_ci: [], task_sla: [], sysapproval_approver: [],
    journal: [], audit: [], attachments: [],
    manifest: {
      label: 'loading…', snapshot_date: '', instance: '', captured_at: '',
      tables: [], integrity: { sha256_manifest: '', acl_skips: 0, missing_attachments: 0 },
    },
    loadStatus: {
      ready: false,
      source: null,         // 'export' | 'mock' | null
      table: null,          // currently-loading table
      total: 0,             // set after TABLES is resolved
      loaded: 0,
      error: null,
    },
  };

  // Ensure every alias key has an empty array so reads pre-load don't crash.
  for (const [, alias] of TABLES) {
    if (!(alias in data)) data[alias] = [];
  }
  data.loadStatus.total = TABLES.length;

  // Subscriber pattern so the React shell can re-render as tables stream in.
  const listeners = new Set();
  data.subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const notify = () => { for (const fn of listeners) { try { fn(data); } catch (_) {} } };

  // ServiceNow with sysparm_display_value=all returns every field as
  //   { value: "<raw>", display_value: "<text>" }
  // Flatten to the raw value (sys_id for refs, choice value for choices, etc.)
  // so existing viewer code that expects sys_ids works unchanged. Coerce
  // 'true'/'false' strings to booleans. Stash the display_value under
  // __display_<key> when it differs.
  function flatten(row) {
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

  async function fetchNDJSON(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const rows = [];
    let i = 0;
    while (i < text.length) {
      const j = text.indexOf('\n', i);
      const line = j === -1 ? text.substring(i) : text.substring(i, j);
      i = j === -1 ? text.length : j + 1;
      if (!line) continue;
      try { rows.push(flatten(JSON.parse(line))); } catch (_) { /* skip malformed */ }
    }
    return rows;
  }

  // After all tables are loaded, derive the few fields the viewer assumes
  // exist but ServiceNow doesn't ship directly.
  function postProcess() {
    // sys_choice: ServiceNow's column is `name` (the table name); the viewer
    // looks up by `table`. Mirror it.
    for (const c of data.sys_choice) {
      if (!c.table && c.name) c.table = c.name;
    }

    // Group membership: viewer reads g.member_sys_ids. Build it from the
    // sys_user_grmember pivot.
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

    // sys_journal_field / sys_audit carry the username string but not the
    // user's sys_id. Resolve via sys_user lookup so avatars/links work.
    const userByUsername = new Map();
    for (const u of data.sys_user) {
      if (u.user_name) userByUsername.set(u.user_name, u.sys_id);
    }
    for (const j of data.journal) {
      if (!j.sys_created_by_sys_id && j.sys_created_by) {
        j.sys_created_by_sys_id = userByUsername.get(j.sys_created_by) || null;
      }
    }
    for (const a of data.audit) {
      if (!a.user_sys_id && a.user) {
        a.user_sys_id = userByUsername.get(a.user) || null;
      }
    }

    // task_sla.sla_definition and cmdb_rel_ci.type are reference fields whose
    // human-readable display is what the viewer renders directly.
    for (const s of data.task_sla) {
      if (s.__display_sla_definition) s.sla_definition = s.__display_sla_definition;
    }
    for (const r of data.cmdb_rel_ci) {
      if (r.__display_type) r.type = r.__display_type;
    }

    // Chronological order so the journal/audit tabs look right.
    data.journal.sort((a, b) => (a.sys_created_on || '').localeCompare(b.sys_created_on || ''));
    data.audit.sort((a, b) => (a.sys_created_on || '').localeCompare(b.sys_created_on || ''));
  }

  async function loadFromExport() {
    const manifestRes = await fetch('data/manifest.json');
    if (!manifestRes.ok) throw new Error(`manifest.json: HTTP ${manifestRes.status}`);
    data.manifest = await manifestRes.json();
    data.loadStatus.source = 'export';
    notify();

    for (const [table, alias] of TABLES) {
      data.loadStatus.table = table;
      notify();
      try {
        data[alias] = await fetchNDJSON(`data/${table}.ndjson`);
      } catch (e) {
        // Missing file is OK — happens when a particular table was canceled
        // (most commonly attachments). Empty array is a fine substitute.
        console.warn(`[historicalwow] ${table}: ${e.message} — using empty array`);
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

  function loadFromMock() {
    if (typeof window.HistoricalWowMockSeed !== 'function') {
      throw new Error('No exported data and no mock seed (data-mock.js) loaded.');
    }
    data.loadStatus.source = 'mock';
    data.loadStatus.table = '(mock)';
    notify();
    window.HistoricalWowMockSeed(data);
    postProcess();
    data.loadStatus.loaded = TABLES.length;
    data.loadStatus.table = null;
    data.loadStatus.ready = true;
    notify();
  }

  data.ready = (async () => {
    try {
      await loadFromExport();
    } catch (e) {
      console.warn('[historicalwow] No exports detected — falling back to mock seed.',
                   e && e.message ? e.message : e);
      try {
        loadFromMock();
      } catch (e2) {
        data.loadStatus.error = (e2 && e2.message) || String(e2);
        data.loadStatus.ready = true;
        notify();
      }
    }
  })();

  return data;
})();
