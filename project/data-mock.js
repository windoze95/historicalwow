/* eslint-disable */
// Mock data for HistoricalWow — fallback when no exported data is present in /data.
// Faithful to the original spec: incidents, change_requests, tasks, users,
// groups, CIs, journal entries, audit, attachments — all cross-linked by sys_id.
// The loader (data.js) calls this with its `d` object to populate.

window.HistoricalWowMockSeed = function (d) {
  const sid = (() => {
    let n = 0;
    return () => {
      n++;
      // 32-char hex-ish
      const base = 'a3f9c1' + String(n).padStart(8, '0');
      return (base + '7b2e4d8c0f1a5b6e9d2c7a40').slice(0, 32);
    };
  })();

  // ---------- Reference: Companies ----------
  const companies = [
    { sys_id: sid(), name: "Love's Travel Stops", short: 'LTS' },
    { sys_id: sid(), name: 'Musket Corporation', short: 'MUSK' },
    { sys_id: sid(), name: 'Trillium Drivers', short: 'TRIL' },
  ];

  // ---------- Reference: Departments ----------
  const departments = [
    { sys_id: sid(), name: 'IT Operations', cost_center: 'CC-1001', head: null },
    { sys_id: sid(), name: 'Information Security', cost_center: 'CC-1002', head: null },
    { sys_id: sid(), name: 'Network Engineering', cost_center: 'CC-1003', head: null },
    { sys_id: sid(), name: 'Retail Technology', cost_center: 'CC-1010', head: null },
    { sys_id: sid(), name: 'Fleet Systems', cost_center: 'CC-1015', head: null },
    { sys_id: sid(), name: 'Finance Systems', cost_center: 'CC-2001', head: null },
    { sys_id: sid(), name: 'HR Technology', cost_center: 'CC-3001', head: null },
  ];

  // ---------- Reference: Locations ----------
  const locations = [
    { sys_id: sid(), name: 'OKC HQ — One Love Way', city: 'Oklahoma City', state: 'OK' },
    { sys_id: sid(), name: 'Catoosa DC', city: 'Catoosa', state: 'OK' },
    { sys_id: sid(), name: 'Amarillo Truck Care', city: 'Amarillo', state: 'TX' },
    { sys_id: sid(), name: 'Springfield Region', city: 'Springfield', state: 'MO' },
    { sys_id: sid(), name: 'Phoenix Regional', city: 'Phoenix', state: 'AZ' },
    { sys_id: sid(), name: 'Remote / WFH', city: '', state: '' },
  ];

  // ---------- Reference: Cost Centers ----------
  const cost_centers = [
    { sys_id: sid(), code: 'CC-1001', name: 'IT Ops Run' },
    { sys_id: sid(), code: 'CC-1002', name: 'InfoSec' },
    { sys_id: sid(), code: 'CC-1003', name: 'Network' },
    { sys_id: sid(), code: 'CC-1010', name: 'Retail Tech' },
    { sys_id: sid(), code: 'CC-1015', name: 'Fleet' },
  ];

  // ---------- Users ----------
  const userSeed = [
    ['Julian Dicesare', 'julian.dicesare', 'InfoSec Engineer III', 1, 0],
    ['Marisol Vega', 'marisol.vega', 'Sr. ITSM Analyst', 0, 0],
    ['Aaron Pham', 'aaron.pham', 'Network Engineer II', 2, 1],
    ['Beatrice Okafor', 'beatrice.okafor', 'Service Desk Lead', 0, 0],
    ['Devon Whitley', 'devon.whitley', 'Site Manager', 3, 2],
    ['Priya Ramaswamy', 'priya.ramaswamy', 'Change Manager', 0, 0],
    ['Hank Boudreaux', 'hank.boudreaux', 'Field Tech', 0, 3],
    ['Kim Yoon-ji', 'kim.yoon-ji', 'Application DBA', 5, 0],
    ['Lukas Brandt', 'lukas.brandt', 'Sr. SRE', 0, 0],
    ['Tasha Green', 'tasha.green', 'Service Desk Tier 1', 0, 0],
    ['Rafael Costa', 'rafael.costa', 'Cloud Architect', 0, 4],
    ['Eva Lindgren', 'eva.lindgren', 'Compliance Analyst', 1, 0],
    ['Chen Wei', 'chen.wei', 'Security Engineer II', 1, 0],
    ['Nikhil Suresh', 'nikhil.suresh', 'DevOps Engineer', 0, 0],
    ['Amelia Hart', 'amelia.hart', 'Service Desk Tier 2', 0, 0],
    ['Owen Brody', 'owen.brody', 'Storage Admin', 0, 0],
    ['Yara El-Sayed', 'yara.el-sayed', 'Sr. Application Engineer', 0, 0],
    ['Marcus Tanaka', 'marcus.tanaka', 'Director, IT Operations', 0, 0],
    ['Jess Kowalski', 'jess.kowalski', 'CAB Coordinator', 0, 0],
    ['Sofia Reyes', 'sofia.reyes', 'POS Engineer', 3, 3],
    ['Brandon Mills', 'brandon.mills', 'Tier 3 Escalations', 0, 0],
    ['Grace Holloway', 'grace.holloway', 'Sr. InfoSec Analyst', 1, 0],
    ['Ravi Krishnan', 'ravi.krishnan', 'Linux SME', 0, 0],
    ['Wendy Thatcher', 'wendy.thatcher', 'IT Ops Manager', 0, 0],
  ];

  const sys_user = userSeed.map(([name, email, title, dept_idx, loc_idx]) => ({
    sys_id: sid(),
    name,
    user_name: email,
    email: `${email}@loves.com`,
    title,
    department: departments[dept_idx]?.sys_id || null,
    location: locations[loc_idx]?.sys_id || null,
    company: companies[0].sys_id,
    active: true,
    sys_created_on: '2018-03-12 14:22:08',
    sys_updated_on: '2025-11-04 09:11:32',
  }));

  const userByName = (n) => sys_user.find((u) => u.name === n);

  // ---------- Groups ----------
  const groupSeed = [
    ['Service Desk',           ['Beatrice Okafor', 'Tasha Green', 'Amelia Hart', 'Brandon Mills']],
    ['Network Operations',     ['Aaron Pham', 'Lukas Brandt']],
    ['InfoSec — IR',           ['Julian Dicesare', 'Grace Holloway', 'Chen Wei', 'Eva Lindgren']],
    ['Database Administration',['Kim Yoon-ji', 'Yara El-Sayed']],
    ['Cloud Platform',         ['Rafael Costa', 'Nikhil Suresh', 'Lukas Brandt']],
    ['Retail / POS',           ['Sofia Reyes', 'Devon Whitley', 'Hank Boudreaux']],
    ['Change Advisory Board',  ['Priya Ramaswamy', 'Jess Kowalski', 'Marcus Tanaka', 'Wendy Thatcher']],
    ['Storage & Backup',       ['Owen Brody', 'Ravi Krishnan']],
    ['Field Services',         ['Hank Boudreaux', 'Devon Whitley']],
    ['Tier 3 / Escalations',   ['Brandon Mills', 'Lukas Brandt', 'Yara El-Sayed']],
  ];

  const sys_user_group = groupSeed.map(([name, members]) => ({
    sys_id: sid(),
    name,
    description: `${name} on-call rotation`,
    manager: userByName(members[0])?.sys_id || null,
    member_sys_ids: members.map((m) => userByName(m)?.sys_id).filter(Boolean),
    active: true,
  }));

  const groupByName = (n) => sys_user_group.find((g) => g.name === n);

  // grmember pivot
  const sys_user_grmember = [];
  for (const g of sys_user_group) {
    for (const u of g.member_sys_ids) {
      sys_user_grmember.push({ sys_id: sid(), group: g.sys_id, user: u });
    }
  }

  // ---------- Configuration Items ----------
  const ciSeed = [
    ['POS-OKC-0143',         'cmdb_ci_pos_terminal', 'Operational', 'Retail / POS'],
    ['POS-OKC-0287',         'cmdb_ci_pos_terminal', 'Operational', 'Retail / POS'],
    ['POS-AMRL-0044',        'cmdb_ci_pos_terminal', 'Degraded',    'Retail / POS'],
    ['svc-payments-prod',    'cmdb_ci_appl',         'Operational', 'Cloud Platform'],
    ['svc-payments-stage',   'cmdb_ci_appl',         'Operational', 'Cloud Platform'],
    ['oracle-fin-prod-01',   'cmdb_ci_db_oracle',    'Operational', 'Database Administration'],
    ['oracle-fin-prod-02',   'cmdb_ci_db_oracle',    'Operational', 'Database Administration'],
    ['mssql-hr-prod',        'cmdb_ci_db_mssql',     'Operational', 'Database Administration'],
    ['fwl-okc-edge-01',      'cmdb_ci_firewall',     'Operational', 'Network Operations'],
    ['fwl-okc-edge-02',      'cmdb_ci_firewall',     'Operational', 'Network Operations'],
    ['core-rtr-okc-01',      'cmdb_ci_router',       'Operational', 'Network Operations'],
    ['core-rtr-okc-02',      'cmdb_ci_router',       'Degraded',    'Network Operations'],
    ['idp-okta-prod',        'cmdb_ci_appl',         'Operational', 'InfoSec — IR'],
    ['vpn-gw-east-01',       'cmdb_ci_appl',         'Operational', 'Network Operations'],
    ['vpn-gw-east-02',       'cmdb_ci_appl',         'Down',        'Network Operations'],
    ['azr-storage-prod',     'cmdb_ci_storage',      'Operational', 'Storage & Backup'],
    ['s3-archive-coldline',  'cmdb_ci_storage',      'Operational', 'Storage & Backup'],
    ['k8s-cluster-prod-eus', 'cmdb_ci_kubernetes',   'Operational', 'Cloud Platform'],
    ['k8s-cluster-stg-eus',  'cmdb_ci_kubernetes',   'Operational', 'Cloud Platform'],
    ['svc-fuel-pricing',     'cmdb_ci_appl',         'Operational', 'Fleet Systems'],
    ['svc-loyalty-api',      'cmdb_ci_appl',         'Operational', 'Retail / POS'],
    ['exch-mbx-prod-03',     'cmdb_ci_appl',         'Operational', 'IT Operations'],
    ['ad-dc-okc-01',         'cmdb_ci_win_server',   'Operational', 'IT Operations'],
    ['ad-dc-okc-02',         'cmdb_ci_win_server',   'Operational', 'IT Operations'],
    ['lb-prod-east-01',      'cmdb_ci_appl',         'Operational', 'Network Operations'],
    ['svc-tax-engine',       'cmdb_ci_appl',         'Operational', 'Finance Systems'],
    ['svc-emp-portal',       'cmdb_ci_appl',         'Operational', 'HR Technology'],
  ];

  const cmdb_ci = ciSeed.map(([name, sys_class_name, status, ownerGroup]) => ({
    sys_id: sid(),
    name,
    sys_class_name,
    operational_status: status,
    short_description: `${name} — ${sys_class_name.replace('cmdb_ci_', '')}`,
    owned_by: groupByName(ownerGroup)?.sys_id || null,
    company: companies[0].sys_id,
    location: locations[0].sys_id,
    serial_number: `SN-${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
    sys_created_on: '2021-06-04 11:14:33',
    sys_updated_on: '2026-04-22 16:45:20',
  }));

  const ciByName = (n) => cmdb_ci.find((c) => c.name === n);

  // CI relationships (sample)
  const cmdb_rel_ci = [
    { sys_id: sid(), parent: ciByName('svc-payments-prod').sys_id, child: ciByName('oracle-fin-prod-01').sys_id, type: 'Depends on::Used by' },
    { sys_id: sid(), parent: ciByName('svc-payments-prod').sys_id, child: ciByName('k8s-cluster-prod-eus').sys_id, type: 'Runs on::Hosts' },
    { sys_id: sid(), parent: ciByName('svc-fuel-pricing').sys_id, child: ciByName('k8s-cluster-prod-eus').sys_id, type: 'Runs on::Hosts' },
    { sys_id: sid(), parent: ciByName('svc-loyalty-api').sys_id, child: ciByName('mssql-hr-prod').sys_id, type: 'Depends on::Used by' },
    { sys_id: sid(), parent: ciByName('vpn-gw-east-02').sys_id, child: ciByName('idp-okta-prod').sys_id, type: 'Depends on::Used by' },
    { sys_id: sid(), parent: ciByName('core-rtr-okc-02').sys_id, child: ciByName('fwl-okc-edge-02').sys_id, type: 'Connects to::Connects to' },
  ];

  // ---------- Choice lists (decoders) ----------
  const sys_choice = [
    // incident.state
    { table: 'incident', element: 'state', value: '1', label: 'New' },
    { table: 'incident', element: 'state', value: '2', label: 'In Progress' },
    { table: 'incident', element: 'state', value: '3', label: 'On Hold' },
    { table: 'incident', element: 'state', value: '6', label: 'Resolved' },
    { table: 'incident', element: 'state', value: '7', label: 'Closed' },
    { table: 'incident', element: 'state', value: '8', label: 'Canceled' },
    // priority
    { table: 'incident', element: 'priority', value: '1', label: '1 — Critical' },
    { table: 'incident', element: 'priority', value: '2', label: '2 — High' },
    { table: 'incident', element: 'priority', value: '3', label: '3 — Moderate' },
    { table: 'incident', element: 'priority', value: '4', label: '4 — Low' },
    { table: 'incident', element: 'priority', value: '5', label: '5 — Planning' },
    // change_request.state (typical)
    { table: 'change_request', element: 'state', value: '-5', label: 'New' },
    { table: 'change_request', element: 'state', value: '-4', label: 'Assess' },
    { table: 'change_request', element: 'state', value: '-3', label: 'Authorize' },
    { table: 'change_request', element: 'state', value: '-2', label: 'Scheduled' },
    { table: 'change_request', element: 'state', value: '-1', label: 'Implement' },
    { table: 'change_request', element: 'state', value: '0', label: 'Review' },
    { table: 'change_request', element: 'state', value: '3', label: 'Closed' },
    { table: 'change_request', element: 'state', value: '4', label: 'Canceled' },
    // close_code
    { table: 'incident', element: 'close_code', value: 'solved_permanently', label: 'Solved (permanently)' },
    { table: 'incident', element: 'close_code', value: 'solved_workaround', label: 'Solved (workaround)' },
    { table: 'incident', element: 'close_code', value: 'not_solved_not_reproducible', label: 'Not solved (not reproducible)' },
    { table: 'incident', element: 'close_code', value: 'closed_user_resolved', label: 'Closed/Resolved by Caller' },
  ];

  // ---------- Incidents (heavy mock — ~40) ----------
  // Helper: ISO-ish strings
  const dt = (m, d, h, mn) =>
    `2026-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')} ${String(h).padStart(2,'0')}:${String(mn).padStart(2,'0')}:${String(Math.floor(Math.random()*60)).padStart(2,'0')}`;
  const dt2025 = (m, d, h) =>
    `2025-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')} ${String(h).padStart(2,'0')}:${String(Math.floor(Math.random()*60)).padStart(2,'0')}:${String(Math.floor(Math.random()*60)).padStart(2,'0')}`;

  const incidentSeed = [
    // [number, short, prio, state, caller, group, assignee, ci, opened, updated, close_code?]
    ['INC0421887', 'POS terminal frozen at Amarillo Truck Care lane 3', '1', '7', 'Devon Whitley', 'Retail / POS', 'Sofia Reyes', 'POS-AMRL-0044', dt(4, 28, 6, 12), dt(4, 29, 14, 32), 'solved_permanently'],
    ['INC0421886', 'Payments service intermittent 5xx — east region', '1', '6', 'Marisol Vega', 'Cloud Platform', 'Rafael Costa', 'svc-payments-prod', dt(4, 27, 22, 4), dt(4, 28, 11, 55), 'solved_workaround'],
    ['INC0421882', 'VPN gateway east-02 unreachable', '1', '6', 'Aaron Pham', 'Network Operations', 'Aaron Pham', 'vpn-gw-east-02', dt(4, 27, 7, 40), dt(4, 27, 12, 18), 'solved_permanently'],
    ['INC0421877', 'Okta SSO loops on iOS 18.4.1 only', '2', '2', 'Beatrice Okafor', 'InfoSec — IR', 'Chen Wei', 'idp-okta-prod', dt(4, 26, 9, 22), dt(4, 30, 8, 14), null],
    ['INC0421872', 'Oracle FIN — slow reports after weekend patch', '2', '3', 'Yara El-Sayed', 'Database Administration', 'Kim Yoon-ji', 'oracle-fin-prod-01', dt(4, 25, 11, 8), dt(4, 29, 10, 2), null],
    ['INC0421869', 'Loyalty API returning empty arrays for 0.4% of requests', '3', '2', 'Sofia Reyes', 'Retail / POS', 'Sofia Reyes', 'svc-loyalty-api', dt(4, 25, 16, 30), dt(4, 30, 7, 22), null],
    ['INC0421860', 'Mailbox migration — exch-mbx-prod-03 stalled', '3', '6', 'Amelia Hart', 'IT Operations', 'Wendy Thatcher', 'exch-mbx-prod-03', dt(4, 24, 13, 14), dt(4, 26, 9, 41), 'solved_permanently'],
    ['INC0421855', 'AD replication lag OKC-01 → OKC-02', '2', '6', 'Lukas Brandt', 'IT Operations', 'Lukas Brandt', 'ad-dc-okc-01', dt(4, 23, 5, 11), dt(4, 23, 8, 30), 'solved_permanently'],
    ['INC0421851', 'Tax engine returning wrong rate for OK county codes', '1', '6', 'Marisol Vega', 'Cloud Platform', 'Nikhil Suresh', 'svc-tax-engine', dt(4, 22, 17, 1), dt(4, 23, 22, 10), 'solved_permanently'],
    ['INC0421842', 'Field tablet won\'t sync inventory at Springfield #44', '3', '7', 'Hank Boudreaux', 'Field Services', 'Hank Boudreaux', 'POS-OKC-0287', dt(4, 21, 8, 19), dt(4, 22, 12, 4), 'solved_workaround'],
    ['INC0421833', 'Fleet pricing feed delayed — 22 sites stale', '2', '6', 'Devon Whitley', 'Fleet Systems', 'Yara El-Sayed', 'svc-fuel-pricing', dt(4, 20, 6, 45), dt(4, 20, 11, 12), 'solved_permanently'],
    ['INC0421828', 'Cold-line restore request — 2024-Q4 archive', '4', '6', 'Eva Lindgren', 'Storage & Backup', 'Owen Brody', 's3-archive-coldline', dt(4, 19, 14, 22), dt(4, 21, 9, 50), 'solved_permanently'],
    ['INC0421821', 'Phishing — credential harvest reported by 17 users', '1', '6', 'Grace Holloway', 'InfoSec — IR', 'Julian Dicesare', 'idp-okta-prod', dt(4, 18, 7, 30), dt(4, 19, 16, 22), 'solved_permanently'],
    ['INC0421815', 'Storage — unexpected growth on azr-storage-prod', '3', '2', 'Owen Brody', 'Storage & Backup', 'Owen Brody', 'azr-storage-prod', dt(4, 17, 10, 18), dt(4, 28, 14, 33), null],
    ['INC0421809', 'Core router OKC-02 BGP flapping', '1', '6', 'Aaron Pham', 'Network Operations', 'Aaron Pham', 'core-rtr-okc-02', dt(4, 16, 3, 22), dt(4, 16, 7, 9), 'solved_permanently'],
    ['INC0421803', 'Employee portal — login fails for contractors', '2', '7', 'Tasha Green', 'Service Desk', 'Brandon Mills', 'svc-emp-portal', dt(4, 15, 14, 8), dt(4, 18, 10, 1), 'solved_permanently'],
    ['INC0421797', 'k8s-cluster-prod-eus — node drain stuck', '2', '6', 'Nikhil Suresh', 'Cloud Platform', 'Nikhil Suresh', 'k8s-cluster-prod-eus', dt(4, 14, 12, 20), dt(4, 14, 16, 50), 'solved_permanently'],
    ['INC0421790', 'POS terminal at OKC HQ café fails on chip reads', '3', '6', 'Tasha Green', 'Retail / POS', 'Sofia Reyes', 'POS-OKC-0143', dt(4, 13, 11, 33), dt(4, 14, 10, 5), 'solved_workaround'],
    ['INC0421783', 'Suspicious outbound traffic — fwl-okc-edge-01', '1', '7', 'Chen Wei', 'InfoSec — IR', 'Grace Holloway', 'fwl-okc-edge-01', dt(4, 12, 20, 18), dt(4, 14, 9, 42), 'solved_permanently'],
    ['INC0421775', 'Mailbox quota errors — 38 users in HR', '4', '7', 'Amelia Hart', 'Service Desk', 'Amelia Hart', 'exch-mbx-prod-03', dt(4, 11, 9, 14), dt(4, 12, 8, 22), 'solved_permanently'],
    ['INC0421766', 'MSSQL HR — deadlocks during nightly payroll job', '2', '6', 'Kim Yoon-ji', 'Database Administration', 'Kim Yoon-ji', 'mssql-hr-prod', dt(4, 10, 2, 30), dt(4, 10, 11, 8), 'solved_permanently'],
    ['INC0421760', 'Phoenix region — three POS units offline', '3', '6', 'Hank Boudreaux', 'Field Services', 'Devon Whitley', 'POS-OKC-0287', dt(4, 9, 12, 0), dt(4, 9, 18, 22), 'solved_permanently'],
    ['INC0421751', 'New hire — RDP doesn\'t work after MFA enrollment', '4', '7', 'Tasha Green', 'Service Desk', 'Tasha Green', null, dt(4, 8, 16, 33), dt(4, 9, 10, 10), 'solved_permanently'],
    ['INC0421743', 'Cloud cost alarm — k8s-cluster-stg-eus', '4', '6', 'Rafael Costa', 'Cloud Platform', 'Nikhil Suresh', 'k8s-cluster-stg-eus', dt(4, 7, 14, 22), dt(4, 8, 13, 40), 'solved_permanently'],
    ['INC0421737', 'Storage tier — unexpected promotion to hot tier', '3', '7', 'Owen Brody', 'Storage & Backup', 'Owen Brody', 'azr-storage-prod', dt(4, 6, 11, 42), dt(4, 7, 14, 11), 'solved_permanently'],
    ['INC0421729', 'POS-OKC-0143 — receipt printer wedged', '4', '7', 'Sofia Reyes', 'Retail / POS', 'Sofia Reyes', 'POS-OKC-0143', dt(4, 5, 9, 50), dt(4, 5, 14, 31), 'solved_permanently'],
    ['INC0421722', 'CAB review — emergency change failed validation', '2', '6', 'Priya Ramaswamy', 'Change Advisory Board', 'Jess Kowalski', null, dt(4, 4, 13, 8), dt(4, 5, 9, 22), 'solved_permanently'],
    ['INC0421715', 'Network — packet loss on lb-prod-east-01 floor', '3', '6', 'Lukas Brandt', 'Network Operations', 'Aaron Pham', 'lb-prod-east-01', dt(4, 3, 22, 30), dt(4, 4, 6, 50), 'solved_permanently'],
    ['INC0421708', 'Tier 3 — POS firmware mismatch (12 sites)', '2', '6', 'Brandon Mills', 'Tier 3 / Escalations', 'Brandon Mills', 'POS-OKC-0287', dt(4, 2, 11, 12), dt(4, 3, 16, 0), 'solved_permanently'],
    ['INC0421700', 'Compliance — quarterly access review export failing', '3', '6', 'Eva Lindgren', 'InfoSec — IR', 'Eva Lindgren', null, dt(4, 1, 14, 5), dt(4, 2, 11, 20), 'solved_permanently'],
    ['INC0421693', 'AD DC — replication latency to remote sites', '3', '7', 'Lukas Brandt', 'IT Operations', 'Lukas Brandt', 'ad-dc-okc-02', dt2025(3, 30, 8), dt2025(3, 30, 16), 'solved_permanently'],
    ['INC0421687', 'Loyalty API — 502 spike at 11:00 CT daily', '2', '6', 'Sofia Reyes', 'Retail / POS', 'Sofia Reyes', 'svc-loyalty-api', dt2025(3, 29, 11), dt2025(3, 29, 18), 'solved_permanently'],
    ['INC0421681', 'POS-AMRL-0044 — paper jam sensor stuck', '4', '7', 'Hank Boudreaux', 'Field Services', 'Hank Boudreaux', 'POS-AMRL-0044', dt2025(3, 28, 13), dt2025(3, 28, 16), 'solved_permanently'],
    ['INC0421675', 'Oracle FIN — DG apply lag spike', '2', '6', 'Kim Yoon-ji', 'Database Administration', 'Kim Yoon-ji', 'oracle-fin-prod-02', dt2025(3, 27, 4), dt2025(3, 27, 9), 'solved_permanently'],
    ['INC0421669', 'Service desk overflow — phone line capacity', '3', '7', 'Beatrice Okafor', 'Service Desk', 'Wendy Thatcher', null, dt2025(3, 26, 8), dt2025(3, 26, 18), 'solved_permanently'],
    ['INC0421663', 'VPN gw — cert expiry warning', '2', '7', 'Aaron Pham', 'Network Operations', 'Aaron Pham', 'vpn-gw-east-01', dt2025(3, 25, 15), dt2025(3, 26, 9), 'solved_permanently'],
    ['INC0421657', 'Tax engine — sales tax holiday rule drift', '3', '7', 'Yara El-Sayed', 'Cloud Platform', 'Nikhil Suresh', 'svc-tax-engine', dt2025(3, 24, 9), dt2025(3, 25, 14), 'solved_permanently'],
    ['INC0421651', 'Phishing — third-party vendor compromised', '1', '7', 'Julian Dicesare', 'InfoSec — IR', 'Julian Dicesare', 'idp-okta-prod', dt2025(3, 22, 19), dt2025(3, 24, 12), 'solved_permanently'],
    ['INC0421645', 'Field tablet sync — Catoosa DC dock 7', '4', '7', 'Hank Boudreaux', 'Field Services', 'Hank Boudreaux', null, dt2025(3, 21, 11), dt2025(3, 21, 14), 'solved_permanently'],
    ['INC0421639', 'k8s-cluster-prod-eus — cert-manager renewal', '3', '7', 'Nikhil Suresh', 'Cloud Platform', 'Nikhil Suresh', 'k8s-cluster-prod-eus', dt2025(3, 20, 6), dt2025(3, 20, 8), 'solved_permanently'],
  ];

  const incidents = incidentSeed.map(([number, short, prio, state, caller, group, assignee, ci, opened, updated, close_code]) => {
    const callerU = userByName(caller);
    const assigneeU = userByName(assignee);
    const groupG = groupByName(group);
    const ciC = ci ? ciByName(ci) : null;
    const impact = prio === '1' ? '1' : prio === '2' ? '2' : '3';
    const urgency = prio === '1' ? '1' : prio === '2' ? '2' : '3';
    return {
      sys_id: sid(),
      number,
      short_description: short,
      description:
        `Originally reported by ${caller}.\n\n` +
        `Symptom: ${short.toLowerCase()}.\n` +
        `Initial scope: assessed by ${group}; affected CI: ${ci || 'n/a'}.\n` +
        `User impact: ${prio === '1' ? 'service-impacting for multiple sites' : prio === '2' ? 'localized outage / degradation' : 'limited impact, single user/site'}.`,
      caller_id: callerU?.sys_id,
      opened_by: callerU?.sys_id,
      assigned_to: assigneeU?.sys_id,
      assignment_group: groupG?.sys_id,
      cmdb_ci: ciC?.sys_id || null,
      company: companies[0].sys_id,
      priority: prio,
      impact,
      urgency,
      state,
      category: ciC?.sys_class_name === 'cmdb_ci_pos_terminal' ? 'hardware' : 'software',
      subcategory: '',
      contact_type: ['phone', 'self-service', 'email', 'walk-in'][Math.floor(Math.random() * 4)],
      opened_at: opened,
      sys_created_on: opened,
      sys_updated_on: updated,
      resolved_at: ['6', '7'].includes(state) ? updated : null,
      closed_at: state === '7' ? updated : null,
      close_code,
      close_notes: close_code ? `Resolved per work notes; root cause documented above. ${close_code === 'solved_workaround' ? 'Workaround applied; permanent fix tracked separately.' : ''}` : null,
      legal_hold: number === 'INC0421821' || number === 'INC0421783' || number === 'INC0421651',
    };
  });

  // ---------- Incidents: journal + audit + attachments ----------
  const journal = []; // sys_journal_field
  const audit = []; // sys_audit
  const attachments = []; // sys_attachment

  function addJournal(record_table, record_sid, who_name, kind, body, sys_created_on) {
    const u = userByName(who_name);
    journal.push({
      sys_id: sid(),
      name: record_table,
      element_id: record_sid,
      element: kind, // 'work_notes' | 'comments'
      sys_created_by: u?.user_name || who_name,
      sys_created_by_sys_id: u?.sys_id || null,
      sys_created_on,
      value: body,
    });
  }
  function addAudit(record_table, record_sid, who_name, fieldname, fieldlabel, oldval, newval, sys_created_on) {
    const u = userByName(who_name);
    audit.push({
      sys_id: sid(),
      tablename: record_table,
      documentkey: record_sid,
      fieldname,
      fieldlabel,
      oldvalue: oldval,
      newvalue: newval,
      user: u?.user_name || who_name,
      user_sys_id: u?.sys_id || null,
      sys_created_on,
    });
  }
  function addAttachment(record_table, record_sid, file_name, content_type, size_bytes, who_name, sys_created_on) {
    const u = userByName(who_name);
    attachments.push({
      sys_id: sid(),
      table_name: record_table,
      table_sys_id: record_sid,
      file_name,
      content_type,
      size_bytes,
      sys_created_by: u?.user_name || who_name,
      sys_created_on,
      checksum: 'sha256:' + sid().slice(0, 24),
    });
  }

  // ---- Heavy threads on the top incidents ----
  // INC0421887 — POS frozen
  {
    const inc = incidents.find((i) => i.number === 'INC0421887');
    addJournal('incident', inc.sys_id, 'Devon Whitley', 'comments', 'Reporting from Amarillo Truck Care — lane 3 POS is fully unresponsive after the 06:10 reboot. We had to fail customers over to lane 2.', dt(4, 28, 6, 18));
    addJournal('incident', inc.sys_id, 'Sofia Reyes', 'work_notes', 'Picked up. Initial check: terminal POS-AMRL-0044 not phoning home since 06:08:42. Last good heartbeat showed firmware drift (7.4.2 vs fleet 7.4.4). Pulling EDR + agent logs.', dt(4, 28, 6, 41));
    addJournal('incident', inc.sys_id, 'Sofia Reyes', 'work_notes', 'Confirmed: firmware self-update aborted with ERR_OTA_PARTITION. Same signature as INC0421708 (Tier 3 — POS firmware mismatch). Walking Devon through manual recovery.', dt(4, 28, 7, 22));
    addJournal('incident', inc.sys_id, 'Devon Whitley', 'comments', 'Following the recovery doc Sofia sent. Step 4 — held power 15s, USB stick imaged with 7.4.4 — terminal coming back up.', dt(4, 28, 8, 4));
    addJournal('incident', inc.sys_id, 'Sofia Reyes', 'work_notes', 'Terminal back online at 08:31. Verified five test transactions including chip + tap. EDR + agent reporting normally. Will roll a fleet-wide firmware audit to catch any other 7.4.2 stragglers.', dt(4, 28, 8, 38));
    addJournal('incident', inc.sys_id, 'Sofia Reyes', 'work_notes', 'Audit complete: 3 additional terminals on 7.4.2 (OKC #41 lane 2, Catoosa #07 lanes 1+2). Scheduled silent push for tonight\'s window.', dt(4, 29, 11, 14));
    addJournal('incident', inc.sys_id, 'Sofia Reyes', 'comments', 'Devon — closing this one out. Workflow: if you see ERR_OTA_PARTITION again, it\'s the failed self-update. Don\'t reboot in cycle — call us first.', dt(4, 29, 14, 22));

    addAudit('incident', inc.sys_id, 'Devon Whitley', 'state', 'State', '1', '2', dt(4, 28, 6, 41));
    addAudit('incident', inc.sys_id, 'Sofia Reyes', 'assigned_to', 'Assigned to', '', userByName('Sofia Reyes').sys_id, dt(4, 28, 6, 41));
    addAudit('incident', inc.sys_id, 'Sofia Reyes', 'priority', 'Priority', '2', '1', dt(4, 28, 6, 45));
    addAudit('incident', inc.sys_id, 'Sofia Reyes', 'state', 'State', '2', '6', dt(4, 28, 8, 38));
    addAudit('incident', inc.sys_id, 'Sofia Reyes', 'close_code', 'Close code', '', 'solved_permanently', dt(4, 29, 14, 22));
    addAudit('incident', inc.sys_id, 'Sofia Reyes', 'state', 'State', '6', '7', dt(4, 29, 14, 32));

    addAttachment('incident', inc.sys_id, 'pos-amrl-0044-edr.log', 'text/plain', 184_532, 'Sofia Reyes', dt(4, 28, 7, 1));
    addAttachment('incident', inc.sys_id, 'firmware-recovery-procedure.pdf', 'application/pdf', 612_233, 'Sofia Reyes', dt(4, 28, 7, 22));
    addAttachment('incident', inc.sys_id, 'lane3-photo.jpg', 'image/jpeg', 2_211_004, 'Devon Whitley', dt(4, 28, 6, 19));
  }

  // INC0421886 — payments 5xx
  {
    const inc = incidents.find((i) => i.number === 'INC0421886');
    addJournal('incident', inc.sys_id, 'Marisol Vega', 'comments', 'Pageduty just paged me — payments-prod showing 4.2% 5xx rate over last 5min. SRE on it?', dt(4, 27, 22, 8));
    addJournal('incident', inc.sys_id, 'Rafael Costa', 'work_notes', 'On it. East-region cluster — saw a cert rotation kick off at 22:01 that briefly took out 2/9 pods. Pod cycle stabilized but 5xx is still elevated. Investigating downstream.', dt(4, 27, 22, 14));
    addJournal('incident', inc.sys_id, 'Lukas Brandt', 'work_notes', 'Looking with Rafael. oracle-fin-prod-01 connection pool spiked to 240/250. Suspect a hung query thread is parking connections.', dt(4, 27, 22, 27));
    addJournal('incident', inc.sys_id, 'Kim Yoon-ji', 'work_notes', 'DBA here — confirmed long-running query from a stale backend pod that didn\'t cycle cleanly. Killed session SID 3441. Pool back to 18/250.', dt(4, 27, 22, 39));
    addJournal('incident', inc.sys_id, 'Rafael Costa', 'work_notes', '5xx back to baseline (~0.04%) at 22:46. Workaround applied. Permanent fix is pod-level connection draining on cert reload — filing CHG ticket.', dt(4, 27, 22, 50));
    addJournal('incident', inc.sys_id, 'Rafael Costa', 'work_notes', 'CHG0034891 raised for the pod-level drain logic. Closing this incident as solved-workaround.', dt(4, 28, 11, 50));

    addAudit('incident', inc.sys_id, 'Marisol Vega', 'state', 'State', '1', '2', dt(4, 27, 22, 14));
    addAudit('incident', inc.sys_id, 'Rafael Costa', 'priority', 'Priority', '2', '1', dt(4, 27, 22, 14));
    addAudit('incident', inc.sys_id, 'Rafael Costa', 'state', 'State', '2', '6', dt(4, 27, 22, 50));
    addAudit('incident', inc.sys_id, 'Rafael Costa', 'close_code', 'Close code', '', 'solved_workaround', dt(4, 28, 11, 50));

    addAttachment('incident', inc.sys_id, 'grafana-payments-5xx.png', 'image/png', 388_104, 'Rafael Costa', dt(4, 27, 22, 33));
    addAttachment('incident', inc.sys_id, 'oracle-session-trace.txt', 'text/plain', 22_104, 'Kim Yoon-ji', dt(4, 27, 22, 41));
    addAttachment('incident', inc.sys_id, 'kubectl-events-payments-prod.log', 'text/plain', 144_022, 'Lukas Brandt', dt(4, 27, 22, 30));
  }

  // INC0421877 — Okta SSO loop
  {
    const inc = incidents.find((i) => i.number === 'INC0421877');
    addJournal('incident', inc.sys_id, 'Beatrice Okafor', 'comments', 'Service desk fielding ~12 calls this morning — all iPhone users on iOS 18.4.1 say they get sent back to Okta after entering MFA. Android, desktop fine.', dt(4, 26, 9, 30));
    addJournal('incident', inc.sys_id, 'Chen Wei', 'work_notes', 'Reproduced. Looks like the WebAuthn attestation flow on iOS 18.4.1 is dropping the session cookie before the SAML response posts back. Apple thread today on this.', dt(4, 26, 10, 10));
    addJournal('incident', inc.sys_id, 'Chen Wei', 'work_notes', 'Apple bulletin acknowledges; fix queued for 18.4.2 (~2 weeks). Workaround: switch affected users to Okta Verify push instead of platform authenticator. Coordinating with service desk on a guided flow.', dt(4, 27, 11, 5));
    addJournal('incident', inc.sys_id, 'Beatrice Okafor', 'work_notes', 'Knowledge article KB0007441 published. Service desk routing affected users through it. ~38 users converted so far.', dt(4, 28, 14, 22));
    addJournal('incident', inc.sys_id, 'Chen Wei', 'work_notes', 'Holding open until 18.4.2 ships. Will close after fleet update + spot-check.', dt(4, 30, 8, 14));

    addAudit('incident', inc.sys_id, 'Beatrice Okafor', 'state', 'State', '1', '2', dt(4, 26, 10, 10));
    addAudit('incident', inc.sys_id, 'Chen Wei', 'assignment_group', 'Assignment group', groupByName('Service Desk').sys_id, groupByName('InfoSec — IR').sys_id, dt(4, 26, 10, 10));

    addAttachment('incident', inc.sys_id, 'ios-18.4.1-har-export.har', 'application/json', 2_980_233, 'Chen Wei', dt(4, 26, 10, 10));
    addAttachment('incident', inc.sys_id, 'apple-bulletin.pdf', 'application/pdf', 188_122, 'Chen Wei', dt(4, 27, 11, 5));
  }

  // INC0421821 — phishing
  {
    const inc = incidents.find((i) => i.number === 'INC0421821');
    addJournal('incident', inc.sys_id, 'Grace Holloway', 'work_notes', '17 reports via the Phish Report button between 07:18 and 07:42, all matching subject "Updated 401(k) match — action required". Sender domain: loves-benefits[.]com (typo). Pulling email gateway logs.', dt(4, 18, 7, 50));
    addJournal('incident', inc.sys_id, 'Julian Dicesare', 'work_notes', 'IR engaged. Domain registered 2026-04-17. Hosting on bulletproof provider; obvious credential harvest landing page (clone of Okta). Triggered tenant-wide block via Defender + DNS sinkhole.', dt(4, 18, 8, 22));
    addJournal('incident', inc.sys_id, 'Julian Dicesare', 'work_notes', 'Reviewed Okta logs — 4 users entered creds. Forced session revoke + password reset + MFA factor reset on all 4. Monitoring for follow-on activity.', dt(4, 18, 9, 14));
    addJournal('incident', inc.sys_id, 'Eva Lindgren', 'work_notes', 'Filed regulatory pre-disclosure (PII not exposed, awareness only). Legal aware. Marking record legal_hold = true.', dt(4, 18, 11, 30));
    addJournal('incident', inc.sys_id, 'Julian Dicesare', 'work_notes', '24-hour monitoring window — no follow-on auth from compromised accounts. Comms drafted to all-staff via Beatrice. Resolving.', dt(4, 19, 16, 0));
    addAudit('incident', inc.sys_id, 'Eva Lindgren', 'legal_hold', 'Legal hold', 'false', 'true', dt(4, 18, 11, 30));
    addAudit('incident', inc.sys_id, 'Julian Dicesare', 'priority', 'Priority', '2', '1', dt(4, 18, 8, 22));
    addAudit('incident', inc.sys_id, 'Julian Dicesare', 'state', 'State', '2', '6', dt(4, 19, 16, 0));
    addAudit('incident', inc.sys_id, 'Julian Dicesare', 'state', 'State', '6', '7', dt(4, 19, 16, 22));

    addAttachment('incident', inc.sys_id, 'phish-sample.eml', 'message/rfc822', 41_233, 'Grace Holloway', dt(4, 18, 7, 55));
    addAttachment('incident', inc.sys_id, 'landing-page-screenshot.png', 'image/png', 1_122_400, 'Julian Dicesare', dt(4, 18, 8, 30));
    addAttachment('incident', inc.sys_id, 'okta-affected-users.csv', 'text/csv', 4_122, 'Julian Dicesare', dt(4, 18, 9, 16));
    addAttachment('incident', inc.sys_id, 'comms-allstaff-final.docx', 'application/vnd.openxmlformats', 28_412, 'Beatrice Okafor', dt(4, 19, 15, 30));
  }

  // INC0421882 — VPN gw
  {
    const inc = incidents.find((i) => i.number === 'INC0421882');
    addJournal('incident', inc.sys_id, 'Aaron Pham', 'work_notes', 'vpn-gw-east-02 stopped responding to monitoring at 07:38. Failover took ~90s — east-01 absorbed the load. Investigating.', dt(4, 27, 7, 45));
    addJournal('incident', inc.sys_id, 'Aaron Pham', 'work_notes', 'Console says kernel panic on the active blade. Hot-spare took over but now we\'re running without redundancy. Booting node back up.', dt(4, 27, 8, 22));
    addJournal('incident', inc.sys_id, 'Aaron Pham', 'work_notes', 'Node back online, redundancy restored at 11:55. Crash dump captured for vendor RCA. Resolving — long-tail RCA tracked under PRB0009921 (out-of-scope for archive).', dt(4, 27, 12, 10));
    addAudit('incident', inc.sys_id, 'Aaron Pham', 'state', 'State', '1', '2', dt(4, 27, 7, 45));
    addAudit('incident', inc.sys_id, 'Aaron Pham', 'state', 'State', '2', '6', dt(4, 27, 12, 10));
    addAttachment('incident', inc.sys_id, 'vpn-gw-east-02-crashdump.bin', 'application/octet-stream', 88_223_104, 'Aaron Pham', dt(4, 27, 8, 30));
  }

  // INC0421872 — Oracle slow
  {
    const inc = incidents.find((i) => i.number === 'INC0421872');
    addJournal('incident', inc.sys_id, 'Yara El-Sayed', 'comments', 'Finance team reports month-end reports are taking 4-5x longer since the weekend patch window. Started Monday morning.', dt(4, 25, 11, 15));
    addJournal('incident', inc.sys_id, 'Kim Yoon-ji', 'work_notes', 'Looked at AWR diff weekend vs prior. New plan on the GL_BALANCES query — optimizer flipped to a hash join after stats refresh. Forcing baseline plan.', dt(4, 25, 14, 30));
    addJournal('incident', inc.sys_id, 'Kim Yoon-ji', 'work_notes', 'Baseline plan in place. Test runs back to prior performance. Holding open while finance reruns the heaviest reports.', dt(4, 26, 9, 40));
    addJournal('incident', inc.sys_id, 'Yara El-Sayed', 'comments', 'Finance ran the regional aging report — back to ~22min from the 90+ they were seeing. Thank you.', dt(4, 27, 16, 22));
    addJournal('incident', inc.sys_id, 'Kim Yoon-ji', 'work_notes', 'Holding 48h before close to confirm month-end batch runs cleanly tonight.', dt(4, 29, 10, 0));

    addAttachment('incident', inc.sys_id, 'awr-diff-2026-04-19_22.html', 'text/html', 481_233, 'Kim Yoon-ji', dt(4, 25, 14, 32));
    addAttachment('incident', inc.sys_id, 'sql-baseline.sql', 'text/x-sql', 8_412, 'Kim Yoon-ji', dt(4, 25, 14, 35));
  }

  // Add lighter threads to the rest
  for (const inc of incidents) {
    if (journal.some((j) => j.element_id === inc.sys_id)) continue;
    const callerName = sys_user.find((u) => u.sys_id === inc.caller_id)?.name;
    const assigneeName = sys_user.find((u) => u.sys_id === inc.assigned_to)?.name;
    const opened = inc.opened_at;
    if (callerName) {
      addJournal('incident', inc.sys_id, callerName, 'comments',
        `Reporting: ${inc.short_description.toLowerCase()}. First noticed around the time of opening.`,
        opened);
    }
    if (assigneeName) {
      addJournal('incident', inc.sys_id, assigneeName, 'work_notes',
        `Picked up. Initial triage in progress. ${inc.cmdb_ci ? 'Looking at CI logs.' : 'Gathering info from caller.'}`,
        inc.sys_updated_on);
      addAudit('incident', inc.sys_id, assigneeName, 'state', 'State', '1', '2', inc.sys_updated_on);
      if (['6','7'].includes(inc.state)) {
        addJournal('incident', inc.sys_id, assigneeName, 'work_notes',
          `Resolved. ${inc.close_code === 'solved_workaround' ? 'Workaround applied; permanent fix tracked.' : 'Root cause identified and remediated.'}`,
          inc.sys_updated_on);
        addAudit('incident', inc.sys_id, assigneeName, 'state', 'State', '2', '6', inc.sys_updated_on);
        if (inc.close_code) {
          addAudit('incident', inc.sys_id, assigneeName, 'close_code', 'Close code', '', inc.close_code, inc.sys_updated_on);
        }
      }
    }
    // Some get an attachment
    if (Math.random() > 0.6 && assigneeName) {
      addAttachment('incident', inc.sys_id,
        ['screenshot.png', 'logs.txt', 'config-diff.txt', 'rca.pdf', 'trace.har'][Math.floor(Math.random() * 5)],
        'application/octet-stream',
        Math.floor(Math.random() * 4_000_000 + 100_000),
        assigneeName, inc.sys_updated_on);
    }
  }

  // ---------- Change Requests ----------
  const changeSeed = [
    ['CHG0034901', 'Apply firmware 7.4.4 to remaining POS fleet', '-2', 'Sofia Reyes',  'Retail / POS',         'normal',   'medium', dt(4, 30, 9, 0),  dt(4, 30, 11, 14)],
    ['CHG0034891', 'Pod-level connection drain for cert rotation — payments service', '-1', 'Rafael Costa',  'Cloud Platform', 'standard', 'low',    dt(4, 28, 14, 0),  dt(4, 29, 16, 22)],
    ['CHG0034887', 'Quarterly Oracle FIN patch + DG re-baseline', '0', 'Kim Yoon-ji', 'Database Administration', 'normal', 'medium', dt(4, 24, 11, 0), dt(4, 27, 9, 14)],
    ['CHG0034881', 'Decommission core-rtr-okc-02 (replacement landed)', '-3', 'Aaron Pham', 'Network Operations', 'normal', 'high', dt(4, 22, 13, 0), dt(4, 30, 7, 22)],
    ['CHG0034876', 'Okta — disable platform authenticator pending iOS 18.4.2', '3', 'Chen Wei', 'InfoSec — IR', 'emergency', 'high', dt(4, 26, 12, 0), dt(4, 27, 14, 30)],
    ['CHG0034870', 'Storage — promote azr-storage-prod growth alert threshold', '3', 'Owen Brody', 'Storage & Backup', 'standard', 'low', dt(4, 20, 9, 0), dt(4, 22, 14, 22)],
    ['CHG0034861', 'Fleet pricing feed — switch to event bus topic v2', '-2', 'Yara El-Sayed', 'Fleet Systems', 'normal', 'medium', dt(4, 18, 14, 0), dt(4, 30, 9, 5)],
    ['CHG0034852', 'Quarterly access review export — schema migration', '0', 'Eva Lindgren', 'InfoSec — IR', 'standard', 'low', dt(4, 16, 10, 0), dt(4, 22, 17, 22)],
    ['CHG0034841', 'k8s-cluster-prod-eus — node pool refresh', '3', 'Nikhil Suresh', 'Cloud Platform', 'normal', 'medium', dt(4, 12, 8, 0), dt(4, 14, 18, 22)],
    ['CHG0034832', 'AD DC — relocate FSMO roles to OKC-02', '3', 'Lukas Brandt', 'IT Operations', 'normal', 'high', dt(4, 8, 9, 0), dt(4, 10, 16, 30)],
    ['CHG0034825', 'Mail platform — rolling mailbox quota lift to 100GB', '3', 'Wendy Thatcher', 'IT Operations', 'standard', 'low', dt(4, 4, 13, 0), dt(4, 11, 11, 14)],
    ['CHG0034817', 'Loyalty API — caching layer (redis cluster)', '3', 'Sofia Reyes', 'Retail / POS', 'normal', 'medium', dt(3, 28, 10, 0), dt(4, 5, 14, 22)],
    ['CHG0034810', 'VPN gateway east — TLS cert rotation', '3', 'Aaron Pham', 'Network Operations', 'standard', 'low', dt(3, 25, 16, 0), dt(3, 26, 9, 22)],
    ['CHG0034801', 'Tax engine — 2026 Q2 rate update', '3', 'Nikhil Suresh', 'Cloud Platform', 'standard', 'medium', dt(3, 20, 9, 0), dt(3, 25, 14, 0)],
    ['CHG0034793', 'POS — 7.4.4 firmware (stage 1 — pilot 12 sites)', '3', 'Sofia Reyes', 'Retail / POS', 'normal', 'medium', dt(3, 14, 11, 0), dt(3, 22, 16, 30)],
  ];

  const changes = changeSeed.map(([number, short, state, assignee, group, type, risk, opened, updated]) => {
    const u = userByName(assignee);
    const g = groupByName(group);
    return {
      sys_id: sid(),
      number,
      short_description: short,
      description: `Change request: ${short}.\n\nBackout plan documented separately. Implementation window per CAB approval.`,
      type,
      risk,
      impact: '3',
      state,
      assigned_to: u?.sys_id,
      assignment_group: g?.sys_id,
      requested_by: u?.sys_id,
      cmdb_ci: null,
      company: companies[0].sys_id,
      start_date: opened,
      end_date: state === '3' ? updated : null,
      sys_created_on: opened,
      sys_updated_on: updated,
      legal_hold: false,
    };
  });

  // Add some journal/audit on changes
  {
    const c = changes.find((x) => x.number === 'CHG0034891');
    addJournal('change_request', c.sys_id, 'Rafael Costa', 'work_notes', 'Filing this off the back of INC0421886 — payments cert rotation took out 2/9 pods.', dt(4, 28, 14, 5));
    addJournal('change_request', c.sys_id, 'Priya Ramaswamy', 'work_notes', 'CAB review: standard change, low risk. Approved for next maintenance window.', dt(4, 29, 11, 30));
    addJournal('change_request', c.sys_id, 'Rafael Costa', 'work_notes', 'Implementation complete in stage. Promoting to prod tonight 22:00 CT.', dt(4, 29, 16, 22));
    addAudit('change_request', c.sys_id, 'Priya Ramaswamy', 'state', 'State', '-3', '-2', dt(4, 29, 11, 30));
    addAudit('change_request', c.sys_id, 'Rafael Costa', 'state', 'State', '-2', '-1', dt(4, 29, 16, 22));
    addAttachment('change_request', c.sys_id, 'implementation-plan.pdf', 'application/pdf', 412_233, 'Rafael Costa', dt(4, 28, 14, 30));
    addAttachment('change_request', c.sys_id, 'backout-plan.md', 'text/markdown', 8_412, 'Rafael Costa', dt(4, 28, 14, 32));
  }
  for (const c of changes) {
    if (journal.some((j) => j.element_id === c.sys_id)) continue;
    const assignee = sys_user.find((u) => u.sys_id === c.assigned_to)?.name;
    if (assignee) {
      addJournal('change_request', c.sys_id, assignee, 'work_notes',
        `Change opened. ${c.type === 'emergency' ? 'Emergency CAB consulted.' : 'Standard CAB review pending.'}`, c.sys_created_on);
      if (c.state === '3') {
        addJournal('change_request', c.sys_id, assignee, 'work_notes', 'Implementation complete. Validation passed.', c.sys_updated_on);
      }
    }
  }

  // ---------- Tasks (incident_task / change_task) ----------
  const incident_task = [
    {
      sys_id: sid(),
      number: 'ITASK0001234',
      parent: incidents.find(i => i.number === 'INC0421887').sys_id,
      short_description: 'Manual recovery walk-through with Devon',
      assigned_to: userByName('Sofia Reyes').sys_id,
      assignment_group: groupByName('Retail / POS').sys_id,
      state: '3',
      sys_created_on: dt(4, 28, 7, 0),
    },
    {
      sys_id: sid(),
      number: 'ITASK0001235',
      parent: incidents.find(i => i.number === 'INC0421887').sys_id,
      short_description: 'Fleet firmware 7.4.2 → 7.4.4 audit + push',
      assigned_to: userByName('Sofia Reyes').sys_id,
      assignment_group: groupByName('Retail / POS').sys_id,
      state: '3',
      sys_created_on: dt(4, 28, 9, 0),
    },
    {
      sys_id: sid(),
      number: 'ITASK0001230',
      parent: incidents.find(i => i.number === 'INC0421821').sys_id,
      short_description: 'Force session revoke + password reset for 4 affected users',
      assigned_to: userByName('Julian Dicesare').sys_id,
      assignment_group: groupByName('InfoSec — IR').sys_id,
      state: '3',
      sys_created_on: dt(4, 18, 9, 14),
    },
  ];
  const change_task = [
    {
      sys_id: sid(),
      number: 'CTASK0009881',
      parent: changes.find(c => c.number === 'CHG0034891').sys_id,
      short_description: 'Roll change to stage cluster',
      assigned_to: userByName('Nikhil Suresh').sys_id,
      assignment_group: groupByName('Cloud Platform').sys_id,
      state: '3',
      sys_created_on: dt(4, 28, 14, 30),
    },
    {
      sys_id: sid(),
      number: 'CTASK0009882',
      parent: changes.find(c => c.number === 'CHG0034891').sys_id,
      short_description: 'Validate drain behavior under cert rotation',
      assigned_to: userByName('Lukas Brandt').sys_id,
      assignment_group: groupByName('Cloud Platform').sys_id,
      state: '3',
      sys_created_on: dt(4, 28, 14, 35),
    },
  ];

  // ---------- task_ci (many-to-many) ----------
  const task_ci = [];
  for (const inc of incidents) {
    if (inc.cmdb_ci) {
      task_ci.push({ sys_id: sid(), task: inc.sys_id, ci: inc.cmdb_ci });
    }
  }

  // ---------- task_sla (light) ----------
  const task_sla = incidents.filter(i => i.priority === '1' || i.priority === '2').slice(0, 12).map(i => ({
    sys_id: sid(),
    task: i.sys_id,
    sla_definition: i.priority === '1' ? 'P1 Resolution — 4h' : 'P2 Resolution — 8h',
    stage: ['6','7'].includes(i.state) ? 'Achieved' : 'In progress',
    business_percentage: ['6','7'].includes(i.state) ? '88%' : '42%',
    has_breached: false,
  }));

  // ---------- sysapproval_approver ----------
  const sysapproval_approver = changes.filter(c => c.type !== 'standard').slice(0, 8).map(c => ({
    sys_id: sid(),
    sysapproval: c.sys_id,
    approver: userByName('Marcus Tanaka').sys_id,
    state: c.state === '3' ? 'approved' : 'requested',
    comments: '',
    sys_created_on: c.sys_created_on,
  }));

  // ---------- Sort journals/audit by record + time ----------
  journal.sort((a, b) => a.sys_created_on.localeCompare(b.sys_created_on));
  audit.sort((a, b) => a.sys_created_on.localeCompare(b.sys_created_on));

  // ---------- Snapshot manifest summary ----------
  const manifest = {
    label: 'T-baseline',
    snapshot_date: '2026-04-30',
    instance: 'loves.service-now.com',
    captured_at: '2026-04-30T03:14:22Z',
    tables: [
      { table: 'incident',           rows: incidents.length,         source_rows: 420562 },
      { table: 'change_request',     rows: changes.length,           source_rows: 14917 },
      { table: 'incident_task',      rows: incident_task.length,     source_rows: 38221 },
      { table: 'change_task',        rows: change_task.length,       source_rows: 21884 },
      { table: 'sys_user',           rows: sys_user.length,          source_rows: 4218 },
      { table: 'sys_user_group',     rows: sys_user_group.length,    source_rows: 312 },
      { table: 'cmdb_ci',            rows: cmdb_ci.length,           source_rows: 18402 },
      { table: 'cmn_department',     rows: departments.length,       source_rows: 22 },
      { table: 'cmn_location',       rows: locations.length,         source_rows: 612 },
      { table: 'core_company',       rows: companies.length,         source_rows: 3 },
      { table: 'sys_choice',         rows: sys_choice.length,        source_rows: 8421 },
    ],
    integrity: {
      sha256_manifest: 'a3c91e44b9b2d28ff09c5cf8a3e0b9b7e4f1c2308e9b1d6e7a5c0d4f3b8a1e22',
      acl_skips: 7,
      missing_attachments: 0,
    },
  };

  // ---------- Populate the loader's data object ----------
  Object.assign(d, {
    companies, departments, locations, cost_centers,
    sys_user, sys_user_group, sys_user_grmember,
    cmdb_ci, cmdb_rel_ci,
    sys_choice,
    incidents, changes,
    incident_task, change_task,
    task_ci, task_sla, sysapproval_approver,
    journal, audit, attachments,
    manifest,
  });
};
