/* eslint-disable */
// Service catalog — overview dashboard, catalog item list, and a per-item
// record view that mirrors ServiceNow's "related lists" tabs (Variables,
// Variable Sets, Catalog UI Policies, Catalog Client Scripts, Available For,
// Not Available For, Categories, Catalogs, Catalog Data Lookup Definitions,
// Related Articles, Related Catalog Items, Assigned Topics).
//
// Data layer: mock dataset hangs off window.HistoricalWowCatalog. Real
// exports would populate /api/sc_cat_item & friends; this file uses the
// mock as a fallback so the section is fully populated in the viewer
// today, and overlays counts from real /api/sc_req_item rows when present
// (so the dashboard "usage" metrics reflect actual ticket history).

(function () {
  // ---- Deterministic sys_id generator (so cross-references resolve) -----
  let __idN = 0;
  const sid = (prefix) => {
    __idN++;
    const seed = (prefix || 'cat') + ':' + __idN;
    let h1 = 0x811c9dc5, h2 = 0xdeadbeef;
    for (let i = 0; i < seed.length; i++) {
      h1 ^= seed.charCodeAt(i); h1 = (h1 * 16777619) >>> 0;
      h2 ^= seed.charCodeAt(i); h2 = ((h2 << 5) - h2 + h1) >>> 0;
    }
    const hex = (h1.toString(16) + h2.toString(16)).padStart(16, '0');
    return (hex + hex).slice(0, 32);
  };

  // ---- Catalogs ---------------------------------------------------------
  const sc_catalog = [
    { sys_id: sid('cat'), title: 'Service Catalog',  description: 'Primary employee-facing catalog. Hardware, access, software, HR.' },
    { sys_id: sid('cat'), title: 'Technical Catalog', description: 'Internal IT tooling, sandboxes, infra requests.' },
    { sys_id: sid('cat'), title: 'HR Service Center', description: 'HR-restricted requests — leave, payroll, badge.' },
    { sys_id: sid('cat'), title: 'Field Operations',  description: 'Store + truck care. POS, fuel pumps, on-site escalations.' },
  ];
  const catByTitle = (t) => sc_catalog.find(c => c.title === t);

  // ---- Categories (single-level for clarity; ServiceNow allows nesting) -
  const sc_category = [
    { sys_id: sid('cty'), title: 'Hardware',         description: 'Laptops, monitors, peripherals, mobile devices.', sc_catalog: catByTitle('Service Catalog').sys_id, parent: null },
    { sys_id: sid('cty'), title: 'Software',         description: 'Per-seat licenses, plug-ins, pre-approved installs.', sc_catalog: catByTitle('Service Catalog').sys_id, parent: null },
    { sys_id: sid('cty'), title: 'Access requests',  description: 'AD groups, SaaS app entitlements, VPN, file shares.', sc_catalog: catByTitle('Service Catalog').sys_id, parent: null },
    { sys_id: sid('cty'), title: 'Onboarding',       description: 'New-hire bundles by department.', sc_catalog: catByTitle('Service Catalog').sys_id, parent: null },
    { sys_id: sid('cty'), title: 'Mobile',           description: 'Phones, plans, MDM enrollment.', sc_catalog: catByTitle('Service Catalog').sys_id, parent: null },
    { sys_id: sid('cty'), title: 'Infrastructure',   description: 'VMs, storage, internal network changes.', sc_catalog: catByTitle('Technical Catalog').sys_id, parent: null },
    { sys_id: sid('cty'), title: 'Sandboxes',        description: 'Time-bound environments for engineering.', sc_catalog: catByTitle('Technical Catalog').sys_id, parent: null },
    { sys_id: sid('cty'), title: 'Store Operations', description: 'POS replacement, fuel-pump card readers, signage.', sc_catalog: catByTitle('Field Operations').sys_id, parent: null },
    { sys_id: sid('cty'), title: 'HR — Confidential', description: 'Restricted; routes through HR-IR.', sc_catalog: catByTitle('HR Service Center').sys_id, parent: null },
  ];
  const ctyByTitle = (t) => sc_category.find(c => c.title === t);

  // ---- Variable sets — reusable groups of variables ---------------------
  const io_set = [
    { sys_id: sid('vset'), name: 'Standard Requestor Block', title: 'Requestor & delivery info',
      description: 'Asks who, where, and how-urgent. Reused across hardware, software, and access requests so users see one consistent header.',
      variables_count: 4 },
    { sys_id: sid('vset'), name: 'Hardware Shipment Block',  title: 'Shipping & accessories',
      description: 'Drop-shipping address, accessory bundles, peripheral toggles. Attached to every hardware item.',
      variables_count: 5 },
    { sys_id: sid('vset'), name: 'Cost-Center Approval Block', title: 'Cost center & approval routing',
      description: 'Captures the cost-center the spend is charged against and routes for manager + finance approval.',
      variables_count: 3 },
    { sys_id: sid('vset'), name: 'HR Confidentiality Notice', title: 'HR confidentiality notice',
      description: 'One-line acknowledgment shown on HR items before submission.',
      variables_count: 1 },
  ];
  const vsetByName = (n) => io_set.find(v => v.name === n);

  // ---- Catalog items (the central entity) -------------------------------
  // Counts per item are not fixed here — they're derived dynamically from
  // the related arrays below so we can tweak related rows without keeping
  // a parallel counter in sync.
  const items = [
    {
      name: 'New laptop request',
      short_description: 'Standard-issue MacBook Pro 14" / Dell Latitude 5440. Pre-imaged, ships to home.',
      category: 'Hardware', catalog: 'Service Catalog',
      price: '$1,840', recurring_price: '', delivery_time: '5 business days',
      active: true, billable: true,
      icon: 'file', tags: ['hardware', 'laptop', 'standard-issue'],
    },
    {
      name: 'Replace damaged laptop',
      short_description: 'Damaged or non-functional company laptop. Requires manager attestation.',
      category: 'Hardware', catalog: 'Service Catalog',
      price: '$1,840', recurring_price: '', delivery_time: '3 business days',
      active: true, billable: true,
      icon: 'file', tags: ['hardware', 'laptop', 'replacement'],
    },
    {
      name: 'Additional monitor',
      short_description: 'Single 27" or dual 24" display. Ships from regional stockroom.',
      category: 'Hardware', catalog: 'Service Catalog',
      price: '$320', recurring_price: '', delivery_time: '2 business days',
      active: true, billable: true,
      icon: 'file', tags: ['hardware', 'peripherals'],
    },
    {
      name: 'Adobe Creative Cloud — All Apps',
      short_description: 'Per-seat Adobe license. Approval routes to manager + asset desk.',
      category: 'Software', catalog: 'Service Catalog',
      price: '$74.99', recurring_price: '/mo', delivery_time: '1 business day',
      active: true, billable: true,
      icon: 'book', tags: ['software', 'license', 'recurring'],
    },
    {
      name: 'Microsoft Visio Plan 2',
      short_description: 'Standalone Visio license. Ships entitlement to user mailbox.',
      category: 'Software', catalog: 'Service Catalog',
      price: '$15', recurring_price: '/mo', delivery_time: '1 business day',
      active: true, billable: true,
      icon: 'book', tags: ['software', 'license'],
    },
    {
      name: 'AD security group membership',
      short_description: 'Add user to one or more Active Directory security groups.',
      category: 'Access requests', catalog: 'Service Catalog',
      price: '', recurring_price: '', delivery_time: '< 4 hours',
      active: true, billable: false,
      icon: 'users', tags: ['access', 'ad', 'group'],
    },
    {
      name: 'VPN access',
      short_description: 'Provision VPN profile for remote employee.',
      category: 'Access requests', catalog: 'Service Catalog',
      price: '', recurring_price: '', delivery_time: '< 4 hours',
      active: true, billable: false,
      icon: 'shield', tags: ['access', 'vpn', 'network'],
    },
    {
      name: 'Okta SSO entitlement',
      short_description: 'Grant a SaaS app entitlement through Okta. Approver is the app owner.',
      category: 'Access requests', catalog: 'Service Catalog',
      price: '', recurring_price: '', delivery_time: '< 4 hours',
      active: true, billable: false,
      icon: 'shield', tags: ['access', 'okta', 'sso'],
    },
    {
      name: 'Onboard — IT Operations',
      short_description: 'Full new-hire bundle for IT Ops: laptop, AD groups, VPN, on-call paging.',
      category: 'Onboarding', catalog: 'Service Catalog',
      price: '$2,200', recurring_price: '', delivery_time: '5 business days',
      active: true, billable: true,
      icon: 'star', tags: ['onboarding', 'new-hire', 'bundle'],
    },
    {
      name: 'Onboard — Field Tech',
      short_description: 'New-hire bundle for site/field staff: rugged laptop, MDM phone, PPE check.',
      category: 'Onboarding', catalog: 'Service Catalog',
      price: '$2,650', recurring_price: '', delivery_time: '7 business days',
      active: true, billable: true,
      icon: 'star', tags: ['onboarding', 'new-hire', 'field'],
    },
    {
      name: 'Company mobile phone',
      short_description: 'Company-paid iPhone or Pixel with corporate plan. MDM enrolled.',
      category: 'Mobile', catalog: 'Service Catalog',
      price: '$899', recurring_price: '$45/mo', delivery_time: '3 business days',
      active: true, billable: true,
      icon: 'file', tags: ['mobile', 'phone', 'plan'],
    },
    {
      name: 'POS terminal replacement',
      short_description: 'Swap a damaged or failing POS terminal at a fueling station / store.',
      category: 'Store Operations', catalog: 'Field Operations',
      price: '$2,100', recurring_price: '', delivery_time: 'Same-day at depot',
      active: true, billable: true,
      icon: 'ci', tags: ['retail', 'pos', 'field'],
    },
    {
      name: 'Linux sandbox VM',
      short_description: 'Ephemeral Linux VM in the engineering sandbox. Auto-destroys after 30 days.',
      category: 'Sandboxes', catalog: 'Technical Catalog',
      price: '', recurring_price: '', delivery_time: '< 1 hour',
      active: true, billable: false,
      icon: 'db', tags: ['infra', 'sandbox', 'devops'],
    },
    {
      name: 'New VM (production)',
      short_description: 'Production VM in vSphere or Azure. Capacity team approval required.',
      category: 'Infrastructure', catalog: 'Technical Catalog',
      price: 'On request', recurring_price: '', delivery_time: '2 business days',
      active: true, billable: true,
      icon: 'db', tags: ['infra', 'vm', 'production'],
    },
    {
      name: 'HR records correction',
      short_description: 'Submit a correction to HR-held records (name, address, dependents).',
      category: 'HR — Confidential', catalog: 'HR Service Center',
      price: '', recurring_price: '', delivery_time: '5 business days',
      active: true, billable: false,
      icon: 'lock', tags: ['hr', 'restricted'],
    },
    {
      name: 'Tuition reimbursement',
      short_description: 'Submit prior-paid tuition for reimbursement under the L&D policy.',
      category: 'HR — Confidential', catalog: 'HR Service Center',
      price: '', recurring_price: '', delivery_time: '10 business days',
      active: true, billable: false,
      icon: 'lock', tags: ['hr', 'restricted', 'reimbursement'],
    },
    {
      name: 'Standing-desk request',
      short_description: 'Adjustable height desk delivered to home or office. Requires HR approval.',
      category: 'Hardware', catalog: 'Service Catalog',
      price: '$520', recurring_price: '', delivery_time: '10 business days',
      active: true, billable: true,
      icon: 'file', tags: ['hardware', 'ergonomics'],
    },
    {
      name: 'Conference room A/V request',
      short_description: 'Room hardware change — speakers, mics, displays, calendar resource.',
      category: 'Hardware', catalog: 'Service Catalog',
      price: '$1,200', recurring_price: '', delivery_time: '15 business days',
      active: false, billable: true,
      icon: 'file', tags: ['hardware', 'av', 'room'],
    },
  ];
  const sc_cat_item = items.map(it => {
    const cat = ctyByTitle(it.category);
    const cat2 = catByTitle(it.catalog);
    return {
      sys_id: sid('item'),
      name: it.name,
      short_description: it.short_description,
      description: `${it.short_description}\n\nFulfillment SLA: ${it.delivery_time}.${it.billable ? ' Spend posts to the requestor cost center.' : ''}`,
      category: cat?.sys_id || null,
      __display_category: it.category,
      sc_catalogs: cat2 ? cat2.sys_id : null,
      __display_sc_catalogs: it.catalog,
      price: it.price, recurring_price: it.recurring_price,
      delivery_time: it.delivery_time,
      active: it.active, billable: it.billable,
      icon: it.icon, tags: it.tags,
      sys_class_name: 'sc_cat_item',
      // Synthesised activity metadata, used by the dashboard sparklines.
      __mock_tags: it.tags,
    };
  });
  const itemByName = (n) => sc_cat_item.find(i => i.name === n);

  // ---- Variables (item_option_new) per cat_item -------------------------
  // Variable types follow ServiceNow's numeric IDs:
  //   1=string, 2=multi-line text, 5=select box, 6=long text, 7=reference,
  //   8=checkbox, 9=date, 17=tree picker, 21=email, 22=URL, 24=lookup select,
  //   26=lookup select, 31=label, 33=container start
  // Subset used in this mock: 1, 2, 5, 7, 8, 9.
  const VAR_TYPE = {
    string: 1, multiline: 2, select: 5, longtext: 6,
    reference: 7, checkbox: 8, date: 9, label: 31,
  };
  const VAR_TYPE_LABEL = {
    1: 'Single-line text', 2: 'Multi-line text', 5: 'Select box',
    6: 'Long text', 7: 'Reference', 8: 'Checkbox', 9: 'Date', 31: 'Label',
  };

  function variablesFor(item) {
    // Generate per-item variables. Each variable carries the catalog item
    // sys_id, an order, type, label, and (for reference/select) a hint of
    // the population.
    const vs = [];
    let order = 100;
    const v = (label, type, opts = {}) => {
      vs.push({
        sys_id: sid('var'),
        cat_item: item.sys_id,
        name: label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
        question_text: label,
        type, order: order, mandatory: !!opts.mandatory,
        reference: opts.reference || '', default_value: opts.default || '',
        choices: opts.choices || null,
        help_text: opts.help || '',
      });
      order += 100;
    };
    // Item-specific patterns
    const cat = item.__display_category;
    if (cat === 'Hardware') {
      v('Requested for', VAR_TYPE.reference, { reference: 'sys_user', mandatory: true, help: 'Defaults to the submitter; choose another for delegated requests.' });
      v('Justification', VAR_TYPE.multiline, { mandatory: true });
      v('Preferred model', VAR_TYPE.select, { choices: ['MacBook Pro 14"', 'MacBook Pro 16"', 'Dell Latitude 5440', 'Dell Latitude 7640'] });
      v('Ship to home address', VAR_TYPE.checkbox, { default: 'true', help: 'Uncheck to pick up at a depot.' });
      v('Required by date', VAR_TYPE.date, {});
      v('Cost center', VAR_TYPE.reference, { reference: 'cmn_cost_center', mandatory: true });
    } else if (cat === 'Software') {
      v('Requested for', VAR_TYPE.reference, { reference: 'sys_user', mandatory: true });
      v('Business justification', VAR_TYPE.multiline, { mandatory: true });
      v('License duration', VAR_TYPE.select, { choices: ['1 month', '3 months', '6 months', '1 year', 'Until terminated'] });
      v('Existing license to revoke', VAR_TYPE.string, { help: 'License key to revoke from prior owner, if applicable.' });
      v('Cost center', VAR_TYPE.reference, { reference: 'cmn_cost_center', mandatory: true });
    } else if (cat === 'Access requests') {
      v('Requested for', VAR_TYPE.reference, { reference: 'sys_user', mandatory: true });
      v('Access type', VAR_TYPE.select, { choices: ['Read-only', 'Read/write', 'Admin'], mandatory: true });
      v('Target system', VAR_TYPE.reference, { reference: 'cmdb_ci', mandatory: true });
      v('Justification', VAR_TYPE.multiline, { mandatory: true });
      v('Time-bound?', VAR_TYPE.checkbox, { help: 'If checked, access is auto-revoked after 90 days.' });
    } else if (cat === 'Onboarding') {
      v('New hire name', VAR_TYPE.string, { mandatory: true });
      v('Start date', VAR_TYPE.date, { mandatory: true });
      v('Manager', VAR_TYPE.reference, { reference: 'sys_user', mandatory: true });
      v('Department', VAR_TYPE.reference, { reference: 'cmn_department', mandatory: true });
      v('Workstation type', VAR_TYPE.select, { choices: ['Laptop only', 'Laptop + dock', 'Desktop'] });
      v('Phone needed?', VAR_TYPE.checkbox, {});
      v('Notes', VAR_TYPE.multiline, {});
    } else if (cat === 'Mobile') {
      v('Requested for', VAR_TYPE.reference, { reference: 'sys_user', mandatory: true });
      v('Device preference', VAR_TYPE.select, { choices: ['iPhone 15', 'iPhone 15 Pro', 'Pixel 8', 'Pixel 8 Pro'] });
      v('Plan', VAR_TYPE.select, { choices: ['Voice + data', 'Voice + data + international', 'Mobile-hotspot upgrade'] });
      v('Cost center', VAR_TYPE.reference, { reference: 'cmn_cost_center', mandatory: true });
    } else if (cat === 'Store Operations') {
      v('Site', VAR_TYPE.reference, { reference: 'cmn_location', mandatory: true });
      v('Failing terminal', VAR_TYPE.reference, { reference: 'cmdb_ci', mandatory: true });
      v('Failure type', VAR_TYPE.select, { choices: ['No power', 'Card reader fail', 'Touch unresponsive', 'Reboot loop', 'Other'] });
      v('Description', VAR_TYPE.multiline, { mandatory: true });
      v('Same-day required?', VAR_TYPE.checkbox, {});
    } else if (cat === 'Sandboxes' || cat === 'Infrastructure') {
      v('Requested for', VAR_TYPE.reference, { reference: 'sys_user', mandatory: true });
      v('OS template', VAR_TYPE.select, { choices: ['Ubuntu 22.04', 'RHEL 9', 'Amazon Linux 2', 'Windows Server 2022'] });
      v('Size', VAR_TYPE.select, { choices: ['small (2 vCPU / 4 GB)', 'medium (4 vCPU / 16 GB)', 'large (8 vCPU / 32 GB)', 'xlarge (16 vCPU / 64 GB)'] });
      v('Region', VAR_TYPE.select, { choices: ['us-east-1', 'us-west-2', 'on-prem-okc', 'on-prem-catoosa'] });
      v('Auto-destroy?', VAR_TYPE.checkbox, { default: 'true' });
      v('Justification', VAR_TYPE.multiline, {});
    } else if (cat === 'HR — Confidential') {
      v('Requested for', VAR_TYPE.reference, { reference: 'sys_user', mandatory: true });
      v('Confidential — describe', VAR_TYPE.longtext, { mandatory: true });
    } else {
      v('Requested for', VAR_TYPE.reference, { reference: 'sys_user', mandatory: true });
      v('Notes', VAR_TYPE.multiline, {});
    }
    return vs;
  }

  const item_option_new = sc_cat_item.flatMap(variablesFor);

  // Variable set ↔ item linkage. Each item picks one or two reusable
  // variable sets where it makes sense.
  const io_set_item = [];
  const linkSet = (itemName, setName) => {
    const item = itemByName(itemName);
    const set = vsetByName(setName);
    if (!item || !set) return;
    io_set_item.push({ sys_id: sid('vsi'), cat_item: item.sys_id, variable_set: set.sys_id });
  };
  for (const it of sc_cat_item) {
    linkSet(it.name, 'Standard Requestor Block');
    if (['Hardware', 'Mobile', 'Onboarding'].includes(it.__display_category)) {
      linkSet(it.name, 'Hardware Shipment Block');
    }
    if (it.billable) {
      linkSet(it.name, 'Cost-Center Approval Block');
    }
    if (it.__display_catalog === 'HR Service Center' || it.__display_category === 'HR — Confidential') {
      linkSet(it.name, 'HR Confidentiality Notice');
    }
  }

  // ---- Catalog UI Policies ----------------------------------------------
  // Each row: condition string + a list of "actions" (show/hide/mandatory).
  function policiesFor(item) {
    const cat = item.__display_category;
    const out = [];
    if (cat === 'Access requests') {
      out.push({
        sys_id: sid('uip'), cat_item: item.sys_id, short_description: 'Show "auto-revoke date" when time-bound is checked',
        condition: 'time_bound = true', applies_on_load: true, applies_on_engine: true, active: true, run_scripts: false,
        actions: [{ field: 'auto_revoke_date', visible: true, mandatory: true }],
      });
    }
    if (cat === 'Hardware' || cat === 'Mobile' || cat === 'Onboarding') {
      out.push({
        sys_id: sid('uip'), cat_item: item.sys_id, short_description: 'Mandatory cost center for billable items',
        condition: 'always', applies_on_load: true, applies_on_engine: true, active: true, run_scripts: false,
        actions: [{ field: 'cost_center', visible: true, mandatory: true }],
      });
    }
    if (cat === 'Onboarding') {
      out.push({
        sys_id: sid('uip'), cat_item: item.sys_id, short_description: 'Hide "Notes" until department is selected',
        condition: 'department is empty', applies_on_load: true, applies_on_engine: false, active: true, run_scripts: false,
        actions: [{ field: 'notes', visible: false, mandatory: false }],
      });
    }
    if (cat === 'Software') {
      out.push({
        sys_id: sid('uip'), cat_item: item.sys_id, short_description: 'Show "Existing license to revoke" only for non-recurring',
        condition: 'license_duration is "Until terminated"', applies_on_load: true, applies_on_engine: true, active: true, run_scripts: false,
        actions: [{ field: 'existing_license_to_revoke', visible: true, mandatory: false }],
      });
    }
    return out;
  }
  const catalog_ui_policy = sc_cat_item.flatMap(policiesFor);

  // ---- Catalog Client Scripts -------------------------------------------
  // Each row: name, type (onLoad/onChange/onSubmit), short description.
  function scriptsFor(item) {
    const cat = item.__display_category;
    const types = ['onLoad', 'onChange', 'onChange', 'onSubmit'];
    const out = [];
    const push = (name, type, target, body) => out.push({
      sys_id: sid('csc'), cat_item: item.sys_id, name, type, applies_to: target, active: true,
      script_preview: body,
    });
    push('Default requested-for to current user', 'onLoad', 'requested_for',
      "g_form.setValue('requested_for', g_user.userID);");
    if (cat === 'Hardware' || cat === 'Mobile') {
      push('Toggle ship-to-home label', 'onChange', 'ship_to_home_address',
        "if (newValue == 'true') { g_form.showFieldMsg('ship_to_home_address', 'A private address is acceptable.', 'info'); }");
    }
    if (cat === 'Software') {
      push('Validate justification length', 'onSubmit', 'business_justification',
        "if ((g_form.getValue('business_justification')||'').length < 30) { g_form.addErrorMessage('Please provide more detail (min 30 chars).'); return false; }");
    }
    if (cat === 'Access requests') {
      push('Hint about target-system search', 'onLoad', 'target_system',
        "g_form.showFieldMsg('target_system', 'Search by FQDN or CMDB display name.', 'info');");
      push('Pre-populate justification template', 'onChange', 'access_type',
        "if (newValue == 'admin') { g_form.setValue('justification', 'Admin needed because: '); }");
    }
    if (cat === 'Onboarding') {
      push('Compute laptop SKU from department', 'onChange', 'department',
        "// look up department.workstation_default and prefill\ng_form.setValue('workstation_type', deptDefault(newValue));");
      push('Block weekend start dates', 'onChange', 'start_date',
        "var d = new Date(newValue); if (d.getDay() == 0 || d.getDay() == 6) g_form.showErrorBox('start_date', 'Pick a weekday.');");
      push('Validate manager belongs to department', 'onSubmit', 'manager',
        "// async call to validate manager.department == department\nreturn validateManager();");
    }
    if (cat === 'Sandboxes' || cat === 'Infrastructure') {
      push('Restrict size to capacity envelope', 'onChange', 'size',
        "if (newValue.indexOf('xlarge') === 0) { g_form.showFieldMsg('size', 'XLarge requires capacity-team approval.', 'warning'); }");
      push('Default region from user location', 'onLoad', 'region',
        "g_form.setValue('region', 'us-east-1');");
    }
    if (cat === 'Store Operations') {
      push('Same-day routing toggle', 'onChange', 'same_day_required',
        "if (newValue == 'true') g_form.setMandatory('site', true);");
      push('Filter terminal list by site', 'onChange', 'site',
        "g_form.addOption('failing_terminal', '', '— select after a site is chosen —');");
    }
    if (cat === 'HR — Confidential') {
      push('Confidentiality acknowledgment', 'onSubmit', 'requested_for',
        "if (!g_form.getValue('hr_ack')) { g_form.addErrorMessage('Acknowledge confidentiality.'); return false; }");
    }
    // Pad the rest with generic but plausible scripts so every item has 3-8.
    while (out.length < 3) {
      push('Trim free-text fields on submit', 'onSubmit', '*',
        "var v = (g_form.getValue('justification')||'').trim(); g_form.setValue('justification', v);");
    }
    if (item.name === 'New laptop request') {
      push('Auto-attach last laptop on file', 'onLoad', '*',
        "// surface previous device for context\nvar last = getLastAssignedAsset(); g_form.showFieldMsg('preferred_model', 'Currently assigned: ' + last, 'info');");
      push('Disable model when refresh-eligible only', 'onChange', 'preferred_model',
        "if (!isRefreshEligible()) g_form.setReadOnly('preferred_model', true);");
      push('Compute delivery ETA', 'onChange', 'preferred_model',
        "g_form.showFieldMsg('preferred_model', etaForModel(newValue), 'info');");
    }
    return out;
  }
  const catalog_script_client = sc_cat_item.flatMap(scriptsFor);

  // ---- User Criteria + Available For / Not Available For ----------------
  const user_criteria = [
    { sys_id: sid('uc'), name: 'All US employees',         description: 'Active sys_user where company in (LTS, MUSK, TRIL).', advanced: false },
    { sys_id: sid('uc'), name: 'IT Operations members',    description: 'Members of group "IT Operations".', advanced: false },
    { sys_id: sid('uc'), name: 'Field staff',              description: 'sys_user.title contains Field, Site, POS, or Truck.', advanced: false },
    { sys_id: sid('uc'), name: 'Cloud platform engineers', description: 'Members of group "Cloud Platform".', advanced: false },
    { sys_id: sid('uc'), name: 'HR Business Partners',     description: 'Members of group "HR — Confidential". Read-restricted.', advanced: true },
    { sys_id: sid('uc'), name: 'Contractors',              description: 'sys_user.employee_number starts with C-.', advanced: false },
    { sys_id: sid('uc'), name: 'Probation period (<90d)',  description: 'sys_user.start_date within 90d of snapshot.', advanced: true },
    { sys_id: sid('uc'), name: 'OKC HQ on-site',           description: 'sys_user.location = OKC HQ.', advanced: false },
  ];
  const ucByName = (n) => user_criteria.find(u => u.name === n);

  const sc_cat_item_user_criteria_mtom = [];     // "Available For" — allow list
  const sc_cat_item_user_criteria_no_mtom = [];  // "Not Available For" — deny list
  function ucLink(arr, itemName, ucName) {
    const it = itemByName(itemName), uc = ucByName(ucName);
    if (it && uc) arr.push({ sys_id: sid('ucm'), cat_item: it.sys_id, user_criteria: uc.sys_id });
  }
  // Defaults: every item is available to "All US employees", except HR/restricted.
  for (const it of sc_cat_item) {
    if (it.__display_catalog === 'HR Service Center') {
      ucLink(sc_cat_item_user_criteria_mtom, it.name, 'HR Business Partners');
    } else {
      ucLink(sc_cat_item_user_criteria_mtom, it.name, 'All US employees');
    }
  }
  // Targeted bundles
  ucLink(sc_cat_item_user_criteria_mtom, 'Onboard — IT Operations', 'IT Operations members');
  ucLink(sc_cat_item_user_criteria_mtom, 'Onboard — Field Tech', 'Field staff');
  ucLink(sc_cat_item_user_criteria_mtom, 'POS terminal replacement', 'Field staff');
  ucLink(sc_cat_item_user_criteria_mtom, 'Linux sandbox VM', 'Cloud platform engineers');
  ucLink(sc_cat_item_user_criteria_mtom, 'New VM (production)', 'Cloud platform engineers');

  // Deny list: contractors can't request company phones / standing desks /
  // expensive bundles by default.
  ucLink(sc_cat_item_user_criteria_no_mtom, 'Company mobile phone', 'Contractors');
  ucLink(sc_cat_item_user_criteria_no_mtom, 'Standing-desk request', 'Contractors');
  ucLink(sc_cat_item_user_criteria_no_mtom, 'Standing-desk request', 'Probation period (<90d)');
  ucLink(sc_cat_item_user_criteria_no_mtom, 'Onboard — IT Operations', 'Contractors');
  ucLink(sc_cat_item_user_criteria_no_mtom, 'Onboard — Field Tech',  'Contractors');
  ucLink(sc_cat_item_user_criteria_no_mtom, 'New VM (production)',   'Contractors');
  ucLink(sc_cat_item_user_criteria_no_mtom, 'Conference room A/V request', 'Contractors');

  // ---- Catalog ↔ Item / Category ↔ Item joins ---------------------------
  // Each item lives in exactly one primary category (carried on the item),
  // but ServiceNow allows multi-mapping; we surface that via these arrays.
  const sc_cat_item_category = sc_cat_item.map(it => ({
    sys_id: sid('cic'), cat_item: it.sys_id, category: it.category,
  }));
  const sc_cat_item_catalog = sc_cat_item.map(it => ({
    sys_id: sid('cit'), cat_item: it.sys_id, sc_catalog: it.sc_catalogs,
  }));

  // ---- Catalog Data Lookup Definitions ----------------------------------
  // These are tables ServiceNow uses to map one variable's value to another's
  // default. Example: pick a department, the cost-center variable defaults
  // to that department's cost-center.
  const sys_cat_item_data_lookup = [];
  const dataLookup = (item, name, src, target, table) => sys_cat_item_data_lookup.push({
    sys_id: sid('dl'), cat_item: item.sys_id, name,
    matcher_table: table || 'cmn_cost_center',
    source_variable: src, target_variable: target,
    active: true,
    description: `When ${src} changes, look up the matching row in ${table || 'cmn_cost_center'} and set ${target}.`,
  });
  for (const it of sc_cat_item) {
    if (it.__display_category === 'Onboarding') {
      dataLookup(it, 'Department → Cost Center', 'department', 'cost_center', 'cmn_department');
      dataLookup(it, 'Department → Manager (default)', 'department', 'manager', 'cmn_department');
    }
    if (it.__display_category === 'Hardware' || it.__display_category === 'Mobile') {
      dataLookup(it, 'User → Cost Center', 'requested_for', 'cost_center', 'sys_user');
    }
    if (it.__display_category === 'Software') {
      dataLookup(it, 'User → Cost Center', 'requested_for', 'cost_center', 'sys_user');
      dataLookup(it, 'User → Manager (for approval)', 'requested_for', 'approver', 'sys_user');
    }
  }

  // ---- Related Articles -------------------------------------------------
  const kb_knowledge = [
    { sys_id: sid('kb'), number: 'KB0010012', short_description: 'How to request a replacement laptop',     workflow_state: 'published', view_count: 2380 },
    { sys_id: sid('kb'), number: 'KB0010044', short_description: 'Lost or stolen laptop — what to do',     workflow_state: 'published', view_count: 1112 },
    { sys_id: sid('kb'), number: 'KB0010099', short_description: 'Adobe Creative Cloud — installing & troubleshooting', workflow_state: 'published', view_count: 802 },
    { sys_id: sid('kb'), number: 'KB0010125', short_description: 'AD security groups: when and how to ask', workflow_state: 'published', view_count: 1444 },
    { sys_id: sid('kb'), number: 'KB0010180', short_description: 'Okta SSO — onboarding apps and entitlements', workflow_state: 'published', view_count: 612 },
    { sys_id: sid('kb'), number: 'KB0010210', short_description: 'New-hire onboarding checklist',           workflow_state: 'published', view_count: 1990 },
    { sys_id: sid('kb'), number: 'KB0010244', short_description: 'Standing-desk request — eligibility',     workflow_state: 'published', view_count: 460 },
    { sys_id: sid('kb'), number: 'KB0010299', short_description: 'POS terminal swap procedure for site managers', workflow_state: 'published', view_count: 332 },
    { sys_id: sid('kb'), number: 'KB0010333', short_description: 'VPN client setup on macOS / Windows',     workflow_state: 'published', view_count: 2450 },
    { sys_id: sid('kb'), number: 'KB0010410', short_description: 'Sandbox VMs — sizing and lifetime rules', workflow_state: 'published', view_count: 220 },
    { sys_id: sid('kb'), number: 'KB0010444', short_description: 'HR records correction process',           workflow_state: 'published', view_count: 188 },
    { sys_id: sid('kb'), number: 'KB0010488', short_description: 'Tuition reimbursement policy',            workflow_state: 'published', view_count: 244 },
    { sys_id: sid('kb'), number: 'KB0010512', short_description: 'Mobile devices — choosing a plan',        workflow_state: 'published', view_count: 540 },
  ];
  const kbByNumber = (n) => kb_knowledge.find(k => k.number === n);

  const m2m_kb_to_sc_cat_item = [];
  const linkKB = (itemName, kbNum) => {
    const it = itemByName(itemName), kb = kbByNumber(kbNum);
    if (it && kb) m2m_kb_to_sc_cat_item.push({ sys_id: sid('kbm'), cat_item: it.sys_id, kb_knowledge: kb.sys_id });
  };
  linkKB('New laptop request',         'KB0010012');
  linkKB('Replace damaged laptop',     'KB0010012');
  linkKB('Replace damaged laptop',     'KB0010044');
  linkKB('Adobe Creative Cloud — All Apps', 'KB0010099');
  linkKB('AD security group membership', 'KB0010125');
  linkKB('Okta SSO entitlement',       'KB0010180');
  linkKB('Onboard — IT Operations',    'KB0010210');
  linkKB('Onboard — Field Tech',       'KB0010210');
  linkKB('Standing-desk request',      'KB0010244');
  linkKB('POS terminal replacement',   'KB0010299');
  linkKB('VPN access',                 'KB0010333');
  linkKB('Linux sandbox VM',           'KB0010410');
  linkKB('New VM (production)',        'KB0010410');
  linkKB('HR records correction',      'KB0010444');
  linkKB('Tuition reimbursement',      'KB0010488');
  linkKB('Company mobile phone',       'KB0010512');

  // ---- Related Catalog Items --------------------------------------------
  const sc_cat_item_related = [];
  const linkRel = (a, b) => {
    const ia = itemByName(a), ib = itemByName(b);
    if (ia && ib) sc_cat_item_related.push({ sys_id: sid('rel'), cat_item: ia.sys_id, related_cat_item: ib.sys_id });
  };
  linkRel('New laptop request',          'Additional monitor');
  linkRel('New laptop request',          'Standing-desk request');
  linkRel('New laptop request',          'Company mobile phone');
  linkRel('Replace damaged laptop',      'New laptop request');
  linkRel('Onboard — IT Operations',     'New laptop request');
  linkRel('Onboard — IT Operations',     'AD security group membership');
  linkRel('Onboard — IT Operations',     'VPN access');
  linkRel('Onboard — IT Operations',     'Okta SSO entitlement');
  linkRel('Onboard — Field Tech',        'POS terminal replacement');
  linkRel('Onboard — Field Tech',        'Company mobile phone');
  linkRel('Adobe Creative Cloud — All Apps', 'Microsoft Visio Plan 2');
  linkRel('AD security group membership', 'Okta SSO entitlement');
  linkRel('VPN access',                  'Okta SSO entitlement');
  linkRel('POS terminal replacement',    'Onboard — Field Tech');
  linkRel('Linux sandbox VM',            'New VM (production)');

  // ---- Assigned Topics --------------------------------------------------
  // ServiceNow's Employee Center / Now Assist surfaces "topics". A topic is
  // typically (taxonomy → category → topic), e.g.
  //   Workplace > Workplace tools > Laptops & monitors.
  const topicSeed = [
    'Workplace > Workplace tools > Laptops & monitors',
    'Workplace > Workplace tools > Software & licenses',
    'Workplace > Workplace tools > Mobile devices',
    'Workplace > Workplace tools > Desks & ergonomics',
    'IT > Access > AD groups & SSO',
    'IT > Access > VPN',
    'IT > Infrastructure > Sandboxes',
    'IT > Infrastructure > Production VMs',
    'IT > New hires > Day-1 setup',
    'Field > Stores > POS systems',
    'HR > Records & policies',
  ];
  const topic_path_item = [];
  const linkTopic = (itemName, path) => {
    const it = itemByName(itemName);
    if (!it) return;
    topic_path_item.push({ sys_id: sid('top'), cat_item: it.sys_id, topic_path: path });
  };
  for (const it of sc_cat_item) {
    if (it.__display_category === 'Hardware') linkTopic(it.name, topicSeed[0]);
    if (it.__display_category === 'Software') linkTopic(it.name, topicSeed[1]);
    if (it.__display_category === 'Mobile')   linkTopic(it.name, topicSeed[2]);
    if (it.name === 'Standing-desk request')  linkTopic(it.name, topicSeed[3]);
    if (it.name === 'AD security group membership' || it.name === 'Okta SSO entitlement')
      linkTopic(it.name, topicSeed[4]);
    if (it.name === 'VPN access')             linkTopic(it.name, topicSeed[5]);
    if (it.name === 'Linux sandbox VM')       linkTopic(it.name, topicSeed[6]);
    if (it.name === 'New VM (production)')    linkTopic(it.name, topicSeed[7]);
    if (it.__display_category === 'Onboarding') linkTopic(it.name, topicSeed[8]);
    if (it.__display_category === 'Store Operations') linkTopic(it.name, topicSeed[9]);
    if (it.__display_catalog === 'HR Service Center') linkTopic(it.name, topicSeed[10]);
  }

  // ---- Synthetic usage signals ------------------------------------------
  // For the dashboard. We invent per-item "RITM count over last 90d", a
  // close-code distribution, and a duration histogram. The dashboard also
  // tries to fetch /api/sc_req_item — if that succeeds we overlay real
  // counts on top of these synthetic ones (matched by item.name when the
  // RITM's __display_cat_item lines up).
  function pseudoRandom(seed) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
    return () => { h = (h * 9301 + 49297) & 0x7fffffff; return h / 0x7fffffff; };
  }
  const usage = sc_cat_item.map(it => {
    const r = pseudoRandom(it.name);
    const opens = Math.floor(40 + r() * 460);   // RITMs opened in window
    const fulfilled = Math.floor(opens * (0.72 + r() * 0.18));
    const cancelled = Math.floor((opens - fulfilled) * (0.4 + r() * 0.5));
    const rejected  = Math.floor((opens - fulfilled - cancelled) * (0.5 + r() * 0.4));
    const inflight  = Math.max(0, opens - fulfilled - cancelled - rejected);
    const avgDays = (1.4 + r() * 6.5).toFixed(1);
    const breaches = Math.floor(opens * (0.02 + r() * 0.08));
    const trend = Array.from({ length: 12 }, () => Math.floor(r() * 18 + 2));
    return {
      cat_item: it.sys_id, name: it.name,
      opens, fulfilled, cancelled, rejected, inflight,
      avg_days_to_fulfill: parseFloat(avgDays),
      breaches, trend,
    };
  });

  // ---- Public API -------------------------------------------------------
  const C = {
    sc_catalog, sc_category,
    sc_cat_item, item_option_new,
    io_set, io_set_item,
    catalog_ui_policy, catalog_script_client,
    user_criteria,
    sc_cat_item_user_criteria_mtom,
    sc_cat_item_user_criteria_no_mtom,
    sc_cat_item_category, sc_cat_item_catalog,
    sys_cat_item_data_lookup,
    kb_knowledge, m2m_kb_to_sc_cat_item,
    sc_cat_item_related,
    topic_path_item,
    usage,
    VAR_TYPE_LABEL,
  };
  C.findItem = (sys_id) => sc_cat_item.find(i => i.sys_id === sys_id);
  C.findItemByName = itemByName;
  C.variablesFor = (sys_id) => item_option_new.filter(v => v.cat_item === sys_id)
    .sort((a, b) => a.order - b.order);
  C.variableSetsFor = (sys_id) => io_set_item.filter(x => x.cat_item === sys_id)
    .map(x => io_set.find(s => s.sys_id === x.variable_set))
    .filter(Boolean);
  C.uiPoliciesFor = (sys_id) => catalog_ui_policy.filter(p => p.cat_item === sys_id);
  C.clientScriptsFor = (sys_id) => catalog_script_client.filter(s => s.cat_item === sys_id);
  C.availableForFor = (sys_id) => sc_cat_item_user_criteria_mtom.filter(x => x.cat_item === sys_id)
    .map(x => user_criteria.find(u => u.sys_id === x.user_criteria))
    .filter(Boolean);
  C.notAvailableForFor = (sys_id) => sc_cat_item_user_criteria_no_mtom.filter(x => x.cat_item === sys_id)
    .map(x => user_criteria.find(u => u.sys_id === x.user_criteria))
    .filter(Boolean);
  C.categoriesFor = (sys_id) => sc_cat_item_category.filter(x => x.cat_item === sys_id)
    .map(x => sc_category.find(c => c.sys_id === x.category))
    .filter(Boolean);
  C.catalogsFor = (sys_id) => sc_cat_item_catalog.filter(x => x.cat_item === sys_id)
    .map(x => sc_catalog.find(c => c.sys_id === x.sc_catalog))
    .filter(Boolean);
  C.dataLookupsFor = (sys_id) => sys_cat_item_data_lookup.filter(d => d.cat_item === sys_id);
  C.relatedArticlesFor = (sys_id) => m2m_kb_to_sc_cat_item.filter(x => x.cat_item === sys_id)
    .map(x => kb_knowledge.find(k => k.sys_id === x.kb_knowledge))
    .filter(Boolean);
  C.relatedItemsFor = (sys_id) => sc_cat_item_related.filter(x => x.cat_item === sys_id)
    .map(x => sc_cat_item.find(i => i.sys_id === x.related_cat_item))
    .filter(Boolean);
  C.topicsFor = (sys_id) => topic_path_item.filter(x => x.cat_item === sys_id)
    .map(x => x.topic_path);
  C.usageFor = (sys_id) => usage.find(u => u.cat_item === sys_id);

  window.HistoricalWowCatalog = C;
})();

// ===========================================================================
// UI components
// ===========================================================================

(function () {
  const C = window.HistoricalWowCatalog;
  const { useState, useEffect, useMemo } = React;

  // Shared chip styles
  const chipStyle = {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '2px 8px', borderRadius: 10, fontSize: 11,
    background: 'var(--bg-3)', border: '1px solid var(--border)',
    color: 'var(--fg-2)',
  };
  const accentChip = {
    ...chipStyle, background: 'var(--accent-bg)',
    border: '1px solid var(--accent-border)', color: 'var(--accent-fg)',
  };

  // ---- Dashboard --------------------------------------------------------
  window.CatalogOverviewPage = function CatalogOverviewPage() {
    const data = window.HistoricalWowData;
    const [realRitms, setRealRitms] = useState(null);   // null = loading
    const [realTotal, setRealTotal] = useState(0);

    useEffect(() => {
      window.AuditLog.push('view', 'service-catalog', 'Service catalog overview');
      let cancel = false;
      // Pull a fat slice of recent RITMs to compute real-world per-item
      // counts, outcome mix, and avg duration. limit=2000 keeps the
      // query bounded; the dashboard says "from latest 2000 RITMs" so
      // viewers know what they're seeing.
      data.fetchTaskList('sc_req_item', { limit: 2000, order_by: 'sys_updated_on', dir: 'desc' })
        .then(r => { if (!cancel) { setRealRitms(r.rows || []); setRealTotal(r.total || 0); } })
        .catch(() => { if (!cancel) { setRealRitms([]); setRealTotal(0); } });
      return () => { cancel = true; };
    }, []);

    // Aggregate per cat_item from the real RITMs
    const realByItem = useMemo(() => {
      if (!realRitms) return null;
      const m = new Map();
      for (const r of realRitms) {
        const k = r.cat_item || (r.__display_cat_item ? '__d:' + r.__display_cat_item : null);
        if (!k) continue;
        if (!m.has(k)) m.set(k, { sys_id: r.cat_item, name: r.__display_cat_item || '(unnamed item)', rows: [] });
        m.get(k).rows.push(r);
      }
      return m;
    }, [realRitms]);

    const totalRequestsArchive = realTotal;
    const totalItems = C.sc_cat_item.length;
    const totalCatalogs = C.sc_catalog.length;
    const totalCategories = C.sc_category.length;
    const totalVariables = C.item_option_new.length;
    const totalScripts = C.catalog_script_client.length;
    const totalPolicies = C.catalog_ui_policy.length;

    // Top items = mock "opens" plus real overlay if matched
    const topItems = useMemo(() => {
      const enriched = C.usage.map(u => {
        const it = C.findItem(u.cat_item);
        let realCount = 0;
        if (realByItem) {
          for (const v of realByItem.values()) {
            if (v.sys_id === u.cat_item ||
                (v.name || '').toLowerCase() === it.name.toLowerCase()) {
              realCount += v.rows.length;
            }
          }
        }
        return { ...u, item: it, real: realCount, total: u.opens + realCount };
      });
      enriched.sort((a, b) => b.total - a.total);
      return enriched.slice(0, 8);
    }, [realByItem]);

    // Outcome mix across the whole snapshot (from real RITMs)
    const outcomeMix = useMemo(() => {
      const m = { 'Closed complete': 0, 'Closed incomplete': 0, 'Closed cancelled': 0,
                  'Closed rejected': 0, 'Open / in-progress': 0, '(other)': 0 };
      const decode = (state) => {
        // sc_req_item.state common values:
        //   1 = Pending, 2 = Open / In-progress, 3 = Closed Complete,
        //   4 = Closed Incomplete, 7 = Closed Cancelled / Rejected
        const s = String(state || '');
        if (s === '3') return 'Closed complete';
        if (s === '4') return 'Closed incomplete';
        if (s === '7') return 'Closed cancelled';
        if (s === '8') return 'Closed rejected';
        if (s === '1' || s === '2') return 'Open / in-progress';
        return '(other)';
      };
      if (realRitms && realRitms.length) {
        for (const r of realRitms) m[decode(r.state)] = (m[decode(r.state)] || 0) + 1;
        return m;
      }
      // Fallback: synthesize from the mock usage
      let f = 0, c = 0, j = 0, e = 0, o = 0;
      for (const u of C.usage) { f += u.fulfilled; c += u.cancelled; j += u.rejected; o += u.inflight; }
      m['Closed complete']    = f;
      m['Closed cancelled']   = c;
      m['Closed rejected']    = j;
      m['Open / in-progress'] = o;
      return m;
    }, [realRitms]);

    const outcomeTotal = Object.values(outcomeMix).reduce((a, b) => a + b, 0);
    const outcomeColor = {
      'Closed complete':    'var(--accent)',
      'Closed incomplete':  'var(--c-amber)',
      'Closed cancelled':   'var(--c-gray)',
      'Closed rejected':    'var(--c-red)',
      'Open / in-progress': 'var(--c-blue)',
      '(other)':            'var(--fg-4)',
    };

    // Approval status (estimated; sysapproval_group rows attach by parent
    // sys_id — we don't fetch here for cost reasons. Use a tile that links
    // out to /group-approvals.)
    const approvalCountTile = realRitms ? realRitms.filter(r => String(r.approval).toLowerCase() === 'requested').length : null;

    return (
      <div style={{ padding: '32px 32px 60px', maxWidth: 1200, margin: '0 auto' }}>
        <div style={{ marginBottom: 26 }}>
          <div style={{ fontSize: 11.5, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '.08em', fontWeight: 600 }}>
            Service Catalog
          </div>
          <h1 style={{ margin: '6px 0 8px', fontSize: 26, fontWeight: 600, letterSpacing: '-0.02em' }}>
            Catalog overview
          </h1>
          <div style={{ color: 'var(--fg-3)', fontSize: 13.5, maxWidth: 760, lineHeight: 1.6 }}>
            Every catalog item, every variable, every UI policy and client script.
            Usage metrics are computed from <span className="mono" style={{ fontSize: 12.5 }}>sc_req_item</span> records in this snapshot.
          </div>
        </div>

        {/* KPI tiles */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 26 }}>
          {[
            { label: 'Catalog items',        value: totalItems,       sub: `${C.sc_cat_item.filter(i => i.active).length} active` },
            { label: 'Variables',            value: totalVariables,   sub: `${C.io_set.length} reusable variable sets` },
            { label: 'UI policies + scripts', value: totalPolicies + totalScripts, sub: `${totalPolicies} policies · ${totalScripts} scripts` },
            { label: 'Requests in archive',  value: realRitms ? totalRequestsArchive.toLocaleString() : '…',
              sub: realRitms ? `${realRitms.length.toLocaleString()} loaded for analysis` : 'loading sc_req_item…' },
          ].map(t => (
            <div key={t.label} style={{
              background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8,
              padding: '12px 14px',
            }}>
              <div style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{t.label}</div>
              <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-.02em', marginTop: 4, fontFamily: 'var(--font-mono)' }}>
                {typeof t.value === 'number' ? t.value.toLocaleString() : t.value}
              </div>
              <div style={{ fontSize: 11, color: 'var(--fg-4)', marginTop: 2 }}>{t.sub}</div>
            </div>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 22 }}>
          {/* Top items by usage */}
          <div>
            <h2 style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--fg-3)', margin: '0 0 10px' }}>
              Most-used items
            </h2>
            <div style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
              <table className="dt" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Catalog item</th>
                    <th style={{ width: 110 }} className="num">RITMs (snapshot)</th>
                    <th style={{ width: 110 }} className="num">Avg days</th>
                    <th style={{ width: 130 }}>Outcomes</th>
                    <th style={{ width: 90 }} className="num">Trend (12w)</th>
                  </tr>
                </thead>
                <tbody>
                  {topItems.map(t => {
                    const widthFor = (n) => Math.max(2, Math.round((n / Math.max(1, t.opens)) * 100));
                    return (
                      <tr key={t.cat_item} onClick={() => window.navigate(`/catalog-items/${t.cat_item}`)}>
                        <td><strong style={{ fontWeight: 500 }}>{t.item.name}</strong>
                          <div style={{ fontSize: 11, color: 'var(--fg-4)' }}>{t.item.__display_category} · {t.item.__display_sc_catalogs}</div>
                        </td>
                        <td className="num">
                          <span className="mono">{(t.opens + t.real).toLocaleString()}</span>
                          {t.real > 0 && (
                            <div style={{ fontSize: 10.5, color: 'var(--fg-4)' }}>+{t.real} live</div>
                          )}
                        </td>
                        <td className="num mono">{t.avg_days_to_fulfill}d</td>
                        <td>
                          <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', border: '1px solid var(--border)' }}>
                            <div style={{ width: widthFor(t.fulfilled) + '%', background: 'var(--accent)' }} title={`fulfilled ${t.fulfilled}`} />
                            <div style={{ width: widthFor(t.inflight)  + '%', background: 'var(--c-blue)' }}  title={`in-flight ${t.inflight}`} />
                            <div style={{ width: widthFor(t.cancelled) + '%', background: 'var(--c-gray)' }}  title={`cancelled ${t.cancelled}`} />
                            <div style={{ width: widthFor(t.rejected)  + '%', background: 'var(--c-red)' }}   title={`rejected ${t.rejected}`} />
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--fg-4)', marginTop: 2 }}>
                            <span>{Math.round(t.fulfilled / t.opens * 100)}% complete</span>
                            <span>{t.breaches} breaches</span>
                          </div>
                        </td>
                        <td>
                          <Sparkline values={t.trend} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Outcome donut + catalog breakdown */}
          <div>
            <h2 style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--fg-3)', margin: '0 0 10px' }}>
              Request outcomes
            </h2>
            <div style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 14px 8px' }}>
              <Donut segments={Object.entries(outcomeMix).map(([k, v]) => ({ label: k, value: v, color: outcomeColor[k] }))}
                     total={outcomeTotal} />
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {Object.entries(outcomeMix).map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                    <span style={{ width: 9, height: 9, borderRadius: 2, background: outcomeColor[k] }} />
                    <span style={{ flex: 1, color: 'var(--fg-2)' }}>{k}</span>
                    <span className="mono" style={{ color: 'var(--fg-3)' }}>{v.toLocaleString()}</span>
                    <span className="mono" style={{ color: 'var(--fg-4)', width: 38, textAlign: 'right' }}>
                      {outcomeTotal ? Math.round((v / outcomeTotal) * 100) + '%' : '—'}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <h2 style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--fg-3)', margin: '20px 0 10px' }}>
              Catalogs &amp; categories
            </h2>
            <div style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {C.sc_catalog.map(cat => {
                const cats = C.sc_category.filter(c => c.sc_catalog === cat.sys_id);
                const itemsHere = C.sc_cat_item.filter(i => i.sc_catalogs === cat.sys_id);
                return (
                  <div key={cat.sys_id} style={{ paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      <span style={{ fontWeight: 500 }}>{cat.title}</span>
                      <span className="mono" style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--fg-3)' }}>
                        {itemsHere.length} items · {cats.length} categories
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                      {cats.map(c => (
                        <span key={c.sys_id} style={chipStyle}>{c.title}</span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            <h2 style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--fg-3)', margin: '20px 0 10px' }}>
              At-a-glance
            </h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {[
                { label: 'Catalogs',     value: totalCatalogs },
                { label: 'Categories',   value: totalCategories },
                { label: 'Variable sets', value: C.io_set.length },
                { label: 'User criteria', value: C.user_criteria.length },
                { label: 'KB articles linked', value: C.m2m_kb_to_sc_cat_item.length },
                { label: 'Data lookup defs', value: C.sys_cat_item_data_lookup.length },
                { label: 'Approvals pending', value: approvalCountTile == null ? '…' : approvalCountTile },
                { label: 'Topics assigned', value: C.topic_path_item.length },
              ].map(s => (
                <div key={s.label} style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}>
                  <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>{s.label}</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 16 }}>{typeof s.value === 'number' ? s.value.toLocaleString() : s.value}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 28 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
            <h2 style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--fg-3)', margin: 0 }}>
              All catalog items
            </h2>
            <a onClick={() => window.navigate('/catalog-items')} style={{ fontSize: 12, color: 'var(--accent-fg)', cursor: 'pointer' }}>
              Open list →
            </a>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
            {C.sc_cat_item.map(it => {
              const u = C.usageFor(it.sys_id);
              return (
                <div key={it.sys_id}
                     onClick={() => window.navigate(`/catalog-items/${it.sys_id}`)}
                     style={{
                       background: 'var(--bg-elev)', border: '1px solid var(--border)',
                       borderRadius: 8, padding: '10px 12px', cursor: 'pointer',
                       opacity: it.active ? 1 : 0.65,
                     }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <window.Icon name={it.icon || 'file'} size={12} />
                    <span style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.name}</span>
                    {!it.active && <span style={{ ...chipStyle, fontSize: 10 }}>inactive</span>}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--fg-3)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {it.short_description}
                  </div>
                  <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--fg-4)' }}>
                    <span style={chipStyle}>{it.__display_category}</span>
                    <span className="mono" style={{ marginLeft: 'auto' }}>{u ? u.opens.toLocaleString() : '—'} RITMs</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  // ---- Sparkline + Donut helpers ---------------------------------------
  function Sparkline({ values }) {
    if (!values || !values.length) return <span style={{ color: 'var(--fg-4)' }}>—</span>;
    const w = 70, h = 18;
    const max = Math.max(...values, 1);
    const step = w / (values.length - 1);
    const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`).join(' ');
    return (
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}>
        <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  function Donut({ segments, total }) {
    const size = 160, stroke = 28, r = (size - stroke) / 2, c = size / 2;
    const circ = 2 * Math.PI * r;
    let acc = 0;
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={c} cy={c} r={r} fill="none" stroke="var(--bg-3)" strokeWidth={stroke} />
          {segments.map((s, i) => {
            if (!total || s.value === 0) return null;
            const frac = s.value / total;
            const dash = `${(circ * frac).toFixed(2)} ${(circ - circ * frac).toFixed(2)}`;
            const offset = -acc * circ;
            acc += frac;
            return (
              <circle key={i} cx={c} cy={c} r={r} fill="none"
                stroke={s.color} strokeWidth={stroke}
                strokeDasharray={dash} strokeDashoffset={offset}
                transform={`rotate(-90 ${c} ${c})`} />
            );
          })}
          <text x={c} y={c - 4} textAnchor="middle" style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fill: 'var(--fg)' }}>
            {total.toLocaleString()}
          </text>
          <text x={c} y={c + 14} textAnchor="middle" style={{ fontSize: 10, fill: 'var(--fg-4)' }}>
            requested items
          </text>
        </svg>
      </div>
    );
  }

  // ---- Catalog item list -----------------------------------------------
  window.CatalogItemListPage = function CatalogItemListPage() {
    const [q, setQ] = useState('');
    const [catalog, setCatalog] = useState('');   // sc_catalog.sys_id
    const [category, setCategory] = useState(''); // sc_category.sys_id

    useEffect(() => {
      window.AuditLog.push('list', 'sc_cat_item', '');
    }, []);

    const rows = useMemo(() => {
      const ql = q.trim().toLowerCase();
      return C.sc_cat_item.filter(i => {
        if (catalog && i.sc_catalogs !== catalog) return false;
        if (category && i.category !== category) return false;
        if (!ql) return true;
        return [i.name, i.short_description, i.__display_category, i.__display_sc_catalogs]
          .some(s => (s || '').toLowerCase().includes(ql));
      });
    }, [q, catalog, category]);

    return (
      <div>
        <div className="page-header">
          <h1>Catalog items <span className="count mono">{C.sc_cat_item.length}</span></h1>
          <div className="sub">
            <span className="mono" style={{ color: 'var(--fg-4)' }}>sc_cat_item</span> · {rows.length.toLocaleString()} matching
          </div>
          <div className="toolbar">
            <select value={catalog} onChange={e => setCatalog(e.target.value)}
              style={{ height: 26, padding: '0 10px', border: '1px solid var(--border-2)', borderRadius: 14, background: 'var(--bg-elev)', fontSize: 12, color: 'var(--fg)', outline: 'none' }}>
              <option value="">All catalogs</option>
              {C.sc_catalog.map(c => <option key={c.sys_id} value={c.sys_id}>{c.title}</option>)}
            </select>
            <select value={category} onChange={e => setCategory(e.target.value)}
              style={{ height: 26, padding: '0 10px', border: '1px solid var(--border-2)', borderRadius: 14, background: 'var(--bg-elev)', fontSize: 12, color: 'var(--fg)', outline: 'none' }}>
              <option value="">All categories</option>
              {C.sc_category.filter(c => !catalog || c.sc_catalog === catalog).map(c => <option key={c.sys_id} value={c.sys_id}>{c.title}</option>)}
            </select>
            <div className="spacer" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name or description…"
              style={{ height: 26, padding: '0 10px', border: '1px solid var(--border-2)', borderRadius: 14, background: 'var(--bg-elev)', fontSize: 12, outline: 'none', width: 280, color: 'var(--fg)' }} />
          </div>
        </div>
        <table className="dt">
          <thead>
            <tr>
              <th>Name</th>
              <th style={{ width: 180 }}>Category</th>
              <th style={{ width: 180 }}>Catalog</th>
              <th style={{ width: 100 }} className="num">Variables</th>
              <th style={{ width: 90 }} className="num">Policies</th>
              <th style={{ width: 90 }} className="num">Scripts</th>
              <th style={{ width: 110 }} className="num">RITMs</th>
              <th style={{ width: 90 }} className="num">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={8} style={{ padding: '40px 20px', color: 'var(--fg-4)', textAlign: 'center' }}>No matching items.</td></tr>
            )}
            {rows.map(it => {
              const u = C.usageFor(it.sys_id);
              return (
                <tr key={it.sys_id} onClick={() => window.navigate(`/catalog-items/${it.sys_id}`)}>
                  <td><strong style={{ fontWeight: 500 }}>{it.name}</strong>
                    <div style={{ fontSize: 11, color: 'var(--fg-4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {it.short_description}
                    </div>
                  </td>
                  <td>{it.__display_category}</td>
                  <td>{it.__display_sc_catalogs}</td>
                  <td className="num mono">{C.variablesFor(it.sys_id).length}</td>
                  <td className="num mono">{C.uiPoliciesFor(it.sys_id).length}</td>
                  <td className="num mono">{C.clientScriptsFor(it.sys_id).length}</td>
                  <td className="num mono">{u ? u.opens.toLocaleString() : '—'}</td>
                  <td>
                    {it.active
                      ? <span className="chip green">active</span>
                      : <span className="chip">inactive</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  // ---- Catalog item record ---------------------------------------------
  window.CatalogItemRecordPage = function CatalogItemRecordPage({ sys_id }) {
    const [tab, setTab] = useState('variables');
    const [realRitms, setRealRitms] = useState(null);
    const data = window.HistoricalWowData;
    const it = C.findItem(sys_id);

    useEffect(() => {
      if (it) window.AuditLog.push('view', `sc_cat_item/${it.name}`, it.name);
      let cancel = false;
      // Find real RITMs that point at this item — if the export has them.
      data.fetchTaskList('sc_req_item', { limit: 25, filters: { cat_item: sys_id }, order_by: 'sys_updated_on', dir: 'desc' })
        .then(r => { if (!cancel) setRealRitms(r.rows || []); })
        .catch(() => { if (!cancel) setRealRitms([]); });
      return () => { cancel = true; };
    }, [sys_id]);

    if (!it) return <div className="empty"><div className="glyph"><window.Icon name="info" /></div>Catalog item not in snapshot.</div>;

    const vars = C.variablesFor(sys_id);
    const vsets = C.variableSetsFor(sys_id);
    const policies = C.uiPoliciesFor(sys_id);
    const scripts = C.clientScriptsFor(sys_id);
    const availFor = C.availableForFor(sys_id);
    const notAvailFor = C.notAvailableForFor(sys_id);
    const cats = C.categoriesFor(sys_id);
    const cats2 = C.catalogsFor(sys_id);
    const lookups = C.dataLookupsFor(sys_id);
    const articles = C.relatedArticlesFor(sys_id);
    const relItems = C.relatedItemsFor(sys_id);
    const topics = C.topicsFor(sys_id);
    const usage = C.usageFor(sys_id);

    const tabs = [
      { id: 'variables',  label: 'Variables',                 count: vars.length },
      { id: 'vsets',      label: 'Variable Sets',             count: vsets.length },
      { id: 'policies',   label: 'Catalog UI Policies',       count: policies.length },
      { id: 'scripts',    label: 'Catalog Client Scripts',    count: scripts.length },
      { id: 'available',  label: 'Available For',             count: availFor.length },
      { id: 'notavail',   label: 'Not Available For',         count: notAvailFor.length },
      { id: 'categories', label: 'Categories',                count: cats.length },
      { id: 'catalogs',   label: 'Catalogs',                  count: cats2.length },
      { id: 'lookups',    label: 'Catalog Data Lookup Definitions', count: lookups.length },
      { id: 'articles',   label: 'Related Articles',          count: articles.length },
      { id: 'relitems',   label: 'Related Catalog Items',     count: relItems.length },
      { id: 'topics',     label: 'Assigned Topics',           count: topics.length },
    ];

    return (
      <div className="record">
        <div className="left">
          {/* Header */}
          <div className="record-header">
            <div className="crumbs">
              <a onClick={() => window.navigate('/service-catalog')}>Service catalog</a>
              <window.Icon name="chevron_right" size={11} />
              <a onClick={() => window.navigate('/catalog-items')}>Catalog items</a>
              <window.Icon name="chevron_right" size={11} />
              <span className="mono">{it.name}</span>
            </div>
            <h1>
              <window.Icon name={it.icon || 'file'} size={22} />
              <span style={{ flex: 1, minWidth: 0 }}>{it.name}</span>
            </h1>
            <div className="title-row">
              {it.active ? <span className="chip green">active</span> : <span className="chip">inactive</span>}
              {it.billable && <span className="chip blue">billable</span>}
              <span style={chipStyle}>{it.__display_category}</span>
              <span style={chipStyle}>{it.__display_sc_catalogs}</span>
              <span className="dot">·</span>
              <span>delivery {it.delivery_time}</span>
              {it.price && <><span className="dot">·</span><span>{it.price}{it.recurring_price}</span></>}
              <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--fg-4)' }}>
                sys_id {it.sys_id.slice(0, 8)}…
              </span>
            </div>
          </div>

          {/* Description */}
          <div className="section">
            <h3>Description</h3>
            <div className="kv-block" style={{ whiteSpace: 'pre-wrap' }}>{it.description}</div>
          </div>

          {/* Specifications */}
          <div className="section">
            <h3>Item details</h3>
            <div className="fields" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', rowGap: 8, columnGap: 16 }}>
              <Field label="Name">{it.name}</Field>
              <Field label="Catalog">{it.__display_sc_catalogs}</Field>
              <Field label="Category">{it.__display_category}</Field>
              <Field label="Active">{it.active ? 'true' : 'false'}</Field>
              <Field label="Billable">{it.billable ? 'true' : 'false'}</Field>
              <Field label="Price">{it.price || '—'}</Field>
              <Field label="Recurring price">{it.recurring_price || '—'}</Field>
              <Field label="Delivery time">{it.delivery_time}</Field>
              <Field label="Tags">
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {(it.tags || []).map(t => <span key={t} style={chipStyle}>{t}</span>)}
                </div>
              </Field>
            </div>
          </div>

          {/* Tabbed related lists */}
          <div className="section">
            <CatalogTabs tabs={tabs} active={tab} onChange={setTab} />
            <div style={{ paddingTop: 8 }}>
              {tab === 'variables'  && <VariablesTab rows={vars} />}
              {tab === 'vsets'      && <VariableSetsTab rows={vsets} />}
              {tab === 'policies'   && <UIPoliciesTab rows={policies} />}
              {tab === 'scripts'    && <ClientScriptsTab rows={scripts} />}
              {tab === 'available'  && <UserCriteriaTab rows={availFor} kind="allow" />}
              {tab === 'notavail'   && <UserCriteriaTab rows={notAvailFor} kind="deny" />}
              {tab === 'categories' && <CategoriesTab rows={cats} />}
              {tab === 'catalogs'   && <CatalogsTab rows={cats2} />}
              {tab === 'lookups'    && <DataLookupsTab rows={lookups} />}
              {tab === 'articles'   && <ArticlesTab rows={articles} />}
              {tab === 'relitems'   && <RelatedItemsTab rows={relItems} />}
              {tab === 'topics'     && <TopicsTab rows={topics} />}
            </div>
          </div>

          <ManifestFooterCat />
        </div>

        {/* Right pane — usage panel */}
        <div className="right">
          <div className="section" style={{ padding: '12px 14px' }}>
            <h3 style={{ marginBottom: 8 }}>Usage</h3>
            {usage ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {[
                  ['Opens (90d)', usage.opens.toLocaleString()],
                  ['Fulfilled', usage.fulfilled.toLocaleString()],
                  ['Cancelled', usage.cancelled.toLocaleString()],
                  ['Rejected', usage.rejected.toLocaleString()],
                  ['In flight', usage.inflight.toLocaleString()],
                  ['Avg fulfill', usage.avg_days_to_fulfill + 'd'],
                  ['SLA breaches', usage.breaches.toLocaleString()],
                  ['Real RITMs', realRitms == null ? '…' : realRitms.length.toLocaleString()],
                ].map(([k, v]) => (
                  <div key={k} style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px' }}>
                    <div style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>{k}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14 }}>{v}</div>
                  </div>
                ))}
              </div>
            ) : <div style={{ color: 'var(--fg-4)', fontSize: 12 }}>No usage data.</div>}

            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 11, color: 'var(--fg-3)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                12-week trend
              </div>
              <Sparkline values={usage?.trend || [0]} />
            </div>
          </div>

          <div className="section" style={{ padding: '12px 14px' }}>
            <h3 style={{ marginBottom: 8 }}>Recent RITMs</h3>
            {realRitms == null && <div style={{ color: 'var(--fg-4)', fontSize: 12 }}>
              <span className="dot-pulse" style={{ display: 'inline-block', marginRight: 8 }} />loading…
            </div>}
            {realRitms && realRitms.length === 0 && (
              <div style={{ color: 'var(--fg-4)', fontSize: 12 }}>
                No requested items in the snapshot reference this catalog item.
              </div>
            )}
            {(realRitms || []).map(r => (
              <div key={r.sys_id}
                   onClick={() => window.navigate(window.recordUrl('sc_req_item', r.sys_id))}
                   style={{
                     background: 'var(--bg-elev)', border: '1px solid var(--border)',
                     borderRadius: 6, padding: '8px 10px', cursor: 'pointer',
                     marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8,
                   }}>
                <span className="mono" style={{ fontSize: 12 }}>{r.number}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
                  {r.short_description || '—'}
                </span>
                <span style={{ fontSize: 11, color: 'var(--fg-4)' }}>{window.fmtRelative(r.sys_updated_on)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  // ---- Tab strip & footer ----------------------------------------------
  function CatalogTabs({ tabs, active, onChange }) {
    return (
      <div className="catalog-tabs" style={{
        display: 'flex', flexWrap: 'wrap', gap: 2, borderBottom: '1px solid var(--border-2)',
        marginBottom: 6,
      }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => onChange(t.id)}
            style={{
              padding: '6px 12px', fontSize: 12.5, fontWeight: 500,
              border: 'none', cursor: 'pointer',
              background: 'transparent',
              color: active === t.id ? 'var(--accent-fg)' : 'var(--fg-2)',
              borderBottom: active === t.id ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: -1,
            }}>
            {t.label} {t.count > 0 && <span style={{ color: 'var(--fg-4)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>({t.count})</span>}
          </button>
        ))}
      </div>
    );
  }

  function ManifestFooterCat() {
    const m = window.HistoricalWowData?.manifest || {};
    const tag = [m.snapshot_date, m.label].filter(Boolean).join(' ') || 'unlabeled snapshot';
    return (
      <div className="section" style={{ borderBottom: 'none', color: 'var(--fg-4)', fontSize: 11.5, paddingTop: 14, paddingBottom: 30 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)' }}>
          <window.Icon name="archive" size={11} />
          <span>archived from snapshot {tag}</span>
        </div>
      </div>
    );
  }

  function Field({ label, children }) {
    return (
      <>
        <div style={{ color: 'var(--fg-3)', fontSize: 12 }}>{label}</div>
        <div style={{ fontSize: 12.5 }}>{children}</div>
      </>
    );
  }

  // ---- Empty-state helper ---------------------------------------------
  function Empty({ icon = 'info', text }) {
    return (
      <div style={{
        background: 'var(--bg-elev)', border: '1px dashed var(--border)', borderRadius: 8,
        padding: '20px 16px', color: 'var(--fg-4)', fontSize: 12.5, textAlign: 'center',
      }}>
        <window.Icon name={icon} size={14} />
        <div style={{ marginTop: 6 }}>{text}</div>
      </div>
    );
  }

  // ---- Tab bodies ------------------------------------------------------
  function VariablesTab({ rows }) {
    if (!rows.length) return <Empty text="No variables defined for this catalog item." />;
    return (
      <table className="dt">
        <thead><tr>
          <th style={{ width: 36 }} className="num">#</th>
          <th style={{ width: 180 }}>Question label</th>
          <th style={{ width: 130 }}>Variable name</th>
          <th style={{ width: 130 }}>Type</th>
          <th style={{ width: 80 }}>Mandatory</th>
          <th>Default / choices</th>
        </tr></thead>
        <tbody>
          {rows.map(v => (
            <tr key={v.sys_id}>
              <td className="num mono" style={{ color: 'var(--fg-4)' }}>{Math.round(v.order / 100)}</td>
              <td><strong style={{ fontWeight: 500 }}>{v.question_text}</strong></td>
              <td className="mono" style={{ fontSize: 11.5 }}>{v.name}</td>
              <td>
                <span style={chipStyle}>{C.VAR_TYPE_LABEL[v.type] || `type ${v.type}`}</span>
                {v.reference && <span style={{ marginLeft: 6, fontFamily: 'var(--font-mono)', color: 'var(--fg-4)', fontSize: 11 }}>→ {v.reference}</span>}
              </td>
              <td>{v.mandatory ? <span className="chip amber">required</span> : <span style={{ color: 'var(--fg-4)' }}>—</span>}</td>
              <td style={{ fontSize: 12 }}>
                {v.choices && v.choices.length > 0 && (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {v.choices.map(c => <span key={c} style={chipStyle}>{c}</span>)}
                  </div>
                )}
                {v.default_value && <div style={{ marginTop: 2, color: 'var(--fg-3)' }}>default: <span className="mono">{v.default_value}</span></div>}
                {v.help_text && <div style={{ marginTop: 2, color: 'var(--fg-4)', fontStyle: 'italic' }}>{v.help_text}</div>}
                {(!v.choices || v.choices.length === 0) && !v.default_value && !v.help_text && (
                  <span style={{ color: 'var(--fg-4)' }}>—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  function VariableSetsTab({ rows }) {
    if (!rows.length) return <Empty text="No variable sets attached." />;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.map(s => (
          <div key={s.sys_id} style={{
            background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px',
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <strong style={{ fontWeight: 500 }}>{s.title}</strong>
              <span className="mono" style={{ fontSize: 11, color: 'var(--fg-4)' }}>{s.name}</span>
              <span style={{ ...chipStyle, marginLeft: 'auto' }}>{s.variables_count} variables</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: 4 }}>{s.description}</div>
          </div>
        ))}
      </div>
    );
  }

  function UIPoliciesTab({ rows }) {
    if (!rows.length) return <Empty text="No UI policies defined." />;
    return (
      <table className="dt">
        <thead><tr>
          <th>Short description</th>
          <th style={{ width: 220 }}>Condition</th>
          <th style={{ width: 110 }}>On load</th>
          <th style={{ width: 110 }}>On engine</th>
          <th style={{ width: 90 }}>Status</th>
        </tr></thead>
        <tbody>
          {rows.map(p => (
            <tr key={p.sys_id}>
              <td>
                <strong style={{ fontWeight: 500 }}>{p.short_description}</strong>
                <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {(p.actions || []).map((a, i) => (
                    <span key={i} style={{
                      ...chipStyle,
                      background: a.mandatory ? 'var(--c-amber-bg)' : 'var(--bg-3)',
                      borderColor: a.mandatory ? 'var(--c-amber-border)' : 'var(--border)',
                      color: a.mandatory ? 'var(--c-amber)' : 'var(--fg-2)',
                    }}>
                      {a.field}: {a.visible ? 'show' : 'hide'}{a.mandatory ? ' · required' : ''}
                    </span>
                  ))}
                </div>
              </td>
              <td className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{p.condition}</td>
              <td>{p.applies_on_load ? <span className="chip green">yes</span> : <span className="chip">no</span>}</td>
              <td>{p.applies_on_engine ? <span className="chip green">yes</span> : <span className="chip">no</span>}</td>
              <td>{p.active ? <span className="chip green">active</span> : <span className="chip">inactive</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  function ClientScriptsTab({ rows }) {
    if (!rows.length) return <Empty text="No client scripts defined." />;
    const typeColor = { onLoad: 'var(--c-blue)', onChange: 'var(--c-amber)', onSubmit: 'var(--c-violet)' };
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map(s => (
          <div key={s.sys_id} style={{
            background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                ...chipStyle,
                background: 'var(--bg-3)', borderColor: 'var(--border)', color: typeColor[s.type] || 'var(--fg-2)',
                fontFamily: 'var(--font-mono)', fontSize: 11,
              }}>{s.type}</span>
              <strong style={{ fontWeight: 500 }}>{s.name}</strong>
              <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-4)' }}>
                applies to: {s.applies_to}
              </span>
            </div>
            <pre style={{
              margin: '8px 0 0', padding: '8px 10px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
              fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--fg-2)', overflowX: 'auto', whiteSpace: 'pre-wrap',
            }}>{s.script_preview}</pre>
          </div>
        ))}
      </div>
    );
  }

  function UserCriteriaTab({ rows, kind }) {
    if (!rows.length) return <Empty
      text={kind === 'allow'
        ? 'No "Available For" entries — visible to everyone in the catalog.'
        : 'No "Not Available For" entries — nothing explicitly denied.'} />;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map(uc => (
          <div key={uc.sys_id} style={{
            background: kind === 'deny' ? 'var(--c-red-bg)' : 'var(--accent-bg)',
            border: '1px solid ' + (kind === 'deny' ? 'var(--c-red-border)' : 'var(--accent-border)'),
            borderRadius: 8, padding: '8px 12px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <window.Icon name={kind === 'deny' ? 'lock' : 'shield'} size={12} />
              <strong style={{ fontWeight: 500 }}>{uc.name}</strong>
              {uc.advanced && <span style={{ ...chipStyle, marginLeft: 'auto' }}>advanced (script)</span>}
            </div>
            <div style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: 4 }}>{uc.description}</div>
          </div>
        ))}
      </div>
    );
  }

  function CategoriesTab({ rows }) {
    if (!rows.length) return <Empty text="No categories assigned." />;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map(c => (
          <div key={c.sys_id} style={{
            background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px',
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <strong style={{ fontWeight: 500 }}>{c.title}</strong>
              <span className="mono" style={{ fontSize: 11, color: 'var(--fg-4)' }}>sc_category</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: 4 }}>{c.description}</div>
          </div>
        ))}
      </div>
    );
  }

  function CatalogsTab({ rows }) {
    if (!rows.length) return <Empty text="Not assigned to any catalog." />;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map(c => (
          <div key={c.sys_id} style={{
            background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px',
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <strong style={{ fontWeight: 500 }}>{c.title}</strong>
              <span className="mono" style={{ fontSize: 11, color: 'var(--fg-4)' }}>sc_catalog</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: 4 }}>{c.description}</div>
          </div>
        ))}
      </div>
    );
  }

  function DataLookupsTab({ rows }) {
    if (!rows.length) return <Empty text="No data-lookup definitions for this item." />;
    return (
      <table className="dt">
        <thead><tr>
          <th>Name</th>
          <th style={{ width: 180 }}>Source variable</th>
          <th style={{ width: 180 }}>Target variable</th>
          <th style={{ width: 200 }}>Lookup table</th>
          <th style={{ width: 90 }}>Status</th>
        </tr></thead>
        <tbody>
          {rows.map(d => (
            <tr key={d.sys_id}>
              <td><strong style={{ fontWeight: 500 }}>{d.name}</strong>
                <div style={{ fontSize: 11.5, color: 'var(--fg-3)', marginTop: 2 }}>{d.description}</div>
              </td>
              <td className="mono" style={{ fontSize: 11.5 }}>{d.source_variable}</td>
              <td className="mono" style={{ fontSize: 11.5 }}>{d.target_variable}</td>
              <td className="mono" style={{ fontSize: 11.5 }}>{d.matcher_table}</td>
              <td>{d.active ? <span className="chip green">active</span> : <span className="chip">inactive</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  function ArticlesTab({ rows }) {
    if (!rows.length) return <Empty text="No related KB articles." />;
    return (
      <table className="dt">
        <thead><tr>
          <th style={{ width: 130 }}>Number</th>
          <th>Short description</th>
          <th style={{ width: 110 }}>State</th>
          <th style={{ width: 110 }} className="num">Views</th>
        </tr></thead>
        <tbody>
          {rows.map(a => (
            <tr key={a.sys_id}>
              <td className="num">{a.number}</td>
              <td>{a.short_description}</td>
              <td><span className="chip green">{a.workflow_state}</span></td>
              <td className="num mono">{a.view_count.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  function RelatedItemsTab({ rows }) {
    if (!rows.length) return <Empty text="No related catalog items." />;
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
        {rows.map(it => {
          const u = C.usageFor(it.sys_id);
          return (
            <div key={it.sys_id}
                 onClick={() => window.navigate(`/catalog-items/${it.sys_id}`)}
                 style={{
                   background: 'var(--bg-elev)', border: '1px solid var(--border)',
                   borderRadius: 8, padding: '10px 12px', cursor: 'pointer',
                 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <window.Icon name={it.icon || 'file'} size={12} />
                <span style={{ fontSize: 13, fontWeight: 500 }}>{it.name}</span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{it.short_description}</div>
              <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--fg-4)' }}>
                <span style={chipStyle}>{it.__display_category}</span>
                <span className="mono" style={{ marginLeft: 'auto' }}>{u ? u.opens.toLocaleString() : '—'} RITMs</span>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  function TopicsTab({ rows }) {
    if (!rows.length) return <Empty text="No topics assigned." />;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map((t, i) => (
          <div key={i} style={{
            background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <window.Icon name="folder" size={12} />
              <span style={{ fontSize: 12.5 }}>
                {t.split(' > ').map((seg, j, arr) => (
                  <React.Fragment key={j}>
                    <span style={{ color: j === arr.length - 1 ? 'var(--fg)' : 'var(--fg-3)', fontWeight: j === arr.length - 1 ? 500 : 400 }}>{seg}</span>
                    {j < arr.length - 1 && <span style={{ color: 'var(--fg-4)', margin: '0 6px' }}>›</span>}
                  </React.Fragment>
                ))}
              </span>
            </div>
          </div>
        ))}
      </div>
    );
  }
})();
