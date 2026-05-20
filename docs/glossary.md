# ServiceNow glossary

Quick reference for the ServiceNow concepts that show up across the API surface. Pulled together for integration teams who may not have day-to-day ServiceNow experience.

## Identity & references

**`sys_id`** — every record in ServiceNow has a globally unique 32-character hexadecimal identifier. It's the primary key of every table and the value used for cross-table references. The API uses `sys_id` everywhere — URLs, response bodies, filter values, lookup blob keys.

**`sys_class_name`** — the leaf class of a record in ServiceNow's table-inheritance hierarchy. For example, a record stored in `cmdb_ci` might actually be a `cmdb_ci_server` or `cmdb_ci_database` — `sys_class_name` tells you which. Filtering on `sys_class_name` is the right way to narrow CMDB queries.

**`table_name` / `table_sys_id`** — used by tables that can reference *any* parent table polymorphically (sys_attachment, sys_audit, sys_journal_field). `table_name` is the name of the parent table; `table_sys_id` (or `documentkey` / `element_id` for audit / journal) is the parent record's sys_id.

**Reference fields** — most fields that name another record (`caller_id`, `assignment_group`, `cmdb_ci`, etc.) store the referenced record's `sys_id`. To turn a sys_id into a display name without a follow-up request, use `/api/sys_user_lookup` or `/api/cmdb_ci_lookup`.

**Display value vs value envelope** — many fields in the `raw` JSON come from ServiceNow shaped as `{"value": "abc123", "display_value": "Alice"}`. The `value` is the underlying code or sys_id; `display_value` is the human label. Indexed columns at the top level of each row are flat scalars — extracted from one side of that envelope at build time. See `tables.md` for which columns use which side.

## Tables you'll see most often

**`task`** — ServiceNow's abstract base table for trackable work. Concrete child tables include:

| Child table | Maps to (workflow) | Common abbreviation |
| --- | --- | --- |
| `incident` | Incident management | INC |
| `change_request` | Change management | CHG |
| `problem` | Problem management | PRB |
| `sc_request` | Catalog request — the "shopping cart" header | REQ |
| `sc_req_item` | One line item on a catalog request | RITM |
| `sc_task` | A fulfillment task spawned from a RITM | SCTASK |
| `incident_task` | Subtask of an incident | — |
| `change_task` | Subtask of a change | CTASK |
| `problem_task` | Subtask of a problem | — |
| `asset_task` | Subtask related to asset management | — |
| `sysapproval_group` | Group-approval task | — |

Every `task` descendant carries common fields: `number`, `short_description`, `state`, `priority`, `assigned_to`, `assignment_group`, `caller_id`, `sys_created_on`, `sys_updated_on`. The API exposes the same indexed columns across all of them (see `tables.md` → "Task tables").

**`sys_user`** — users (employees, contractors, system accounts). Joined to via `caller_id`, `assigned_to`, `opened_by`, etc.

**`sys_user_group`** — assignment groups (e.g., "Network Operations", "IT - HR Support"). Joined via `assignment_group`. The HR gate (see [API.md §3](API.md#3-authentication--authorization-hr-gate)) keys off one specific group.

**`sys_user_grmember`** — many-to-many between users and groups.

**`cmdb_ci`** — Configuration Items: servers, applications, databases, network devices, etc. Joined via `cmdb_ci` on tasks. `sys_class_name` narrows to a specific CI type.

**`cmdb_rel_ci`** — relationships between CIs (parent / child). The `/api/related/cmdb/<sys_id>` endpoint expands these into upstream and downstream lists with the related CI's row merged in.

## Activity tables

**`sys_journal_field`** — work notes and customer-facing comments. One row per journal entry; `element_id` references the parent task. `element` is `"work_notes"` or `"comments"` (or `"work_notes_list"`, etc.). The `value` is the entry text.

**`sys_audit`** — field-level change history. One row per single-field change. `documentkey` references the parent record; `tablename` names its table; `fieldname` is the column, `oldvalue` / `newvalue` are the before/after. This is large — `sys_audit` is the highest-volume table in the archive.

**Journal vs audit:** journal = free-text additions (notes, comments). Audit = structured field changes (state went from "Active" to "Resolved"). Both are append-only.

**`sys_attachment`** — metadata for attached files (filename, content type, size, who uploaded, when). The file binaries are served separately at `/data/attachments/<shard>/<sys_id>/<file_name>` — see [API.md §8](API.md#8-static--attachment-routes). `table_sys_id` references the parent record.

## Catalog & request fulfillment

The catalog flow:

1. A user browses **`sc_cat_item`** (catalog items — "request a laptop", "new hire onboarding", etc.).
2. They submit a form. Each form field they fill becomes a row in **`sc_item_option`**, linked to the variable definition in **`item_option_new`**.
3. The submission produces a parent **`sc_request`** (REQ) record.
4. The REQ has one or more child **`sc_req_item`** (RITM) records — one per catalog item ordered.
5. Each RITM may have **`sc_task`** (SCTASK) records — actual fulfillment work assigned to a team.

Other catalog supporting tables:

- **`sc_catalog`** — top-level catalog (e.g., "IT Service Catalog").
- **`sc_category`** — categories within a catalog.
- **`catalog_ui_policy`** / **`catalog_ui_policy_action`** — form-field show/hide/mandatory logic.
- **`catalog_script_client`** — client-side scripts on catalog forms.
- **`user_criteria`** — user-eligibility rules for catalog items.
- **`item_option_new_set`** / **`io_set_item`** — reusable variable sets.
- **`std_change_proposal`** — bridges a catalog item back to a `change_request` template.
- **`question`** / **`question_choice`** — generic-question support for catalog and survey forms.

To reconstruct what a user submitted on a request item, use `/api/variables/<ritm_sys_id>` — it joins through `sc_item_option_mtom` → `sc_item_option` → `item_option_new` for you.

## Asset management (alm_*)

Asset records — physical and logical inventory:

- **`alm_asset`** — base asset table.
- **`alm_hardware`** — laptops, servers, monitors, etc.
- **`alm_software_license`** / **`alm_license`** — software licensing records.
- **`alm_consumable`** — consumable inventory (toner, cables).
- **`alm_facility`** / **`alm_stockroom`** — facilities and stockrooms.

Software-instance tracking lives in **`cmdb_ci_spkg`** (software package definitions) and **`cmdb_software_instance`** (per-CI installations).

## Server-side logic

The archive captures definitions of business rules, scripts, and policies — useful when answering "what runs on this table?":

- **`sys_script`** — server-side business rules. `collection` is the target table.
- **`sys_script_client`** — client-side scripts (run in the browser).
- **`sys_script_include`** — reusable script modules (server-side).
- **`sysauto_script`** — scheduled jobs.
- **`sys_ui_policy`** / **`sys_ui_policy_action`** — UI-layer show/hide/mandatory rules.
- **`sys_data_policy2`** / **`sys_data_policy_rule`** — server-enforced data policies (apply on every write, not just UI).
- **`sys_ui_action`** — form buttons and list buttons.
- **`sys_hub_flow`** — Flow Designer flows.
- **`sys_security_acl`** — Access Control rules. ACL `name` patterns are `"table"`, `"table.field"`, or `"table.action_xyz"`.

Script bodies live in the `raw` envelope (not indexed) — they're large and only ever read out, never queried.

## Metadata

- **`sys_dictionary`** — every field definition on every table. `name` is the table, `element` is the field name. Use this to answer "what fields exist on `<table>`?". `internal_type` (extracted as display value, e.g. "String" / "Reference") describes the field's data type.
- **`sys_dictionary_override`** — per-table overrides of inherited field properties (e.g., `incident` overriding a field defined on the base `task`).
- **`sys_properties`** — instance-wide configuration properties.
- **`sys_choice`** — choice-list definitions. `name` is the table the choice belongs to, `element` is the field, `value` is the underlying code, `label` is the display string.

## Org structure

- **`core_company`** — companies (vendor, customer, internal).
- **`cmn_department`** — departments.
- **`cmn_location`** — physical locations.
- **`cmn_cost_center`** — cost centers.

These are referenced by many other tables (users, assets, etc.).

## Useful abbreviations

| Abbrev | Stands for | Notes |
| --- | --- | --- |
| INC | Incident | `incident` table |
| CHG | Change request | `change_request` table |
| PRB | Problem | `problem` table |
| REQ | Catalog request | `sc_request` table |
| RITM | Requested item | `sc_req_item` table |
| SCTASK | Catalog task | `sc_task` table |
| CI | Configuration item | `cmdb_ci` table family |
| CMDB | Configuration Management Database | The `cmdb_*` table family |
| ACL | Access Control List | `sys_security_acl` |
| OAuth | (used by the exporter only) | Not relevant to API consumers |

## HistoricalWow-specific terms

**`raw`** — a TEXT column on every table holding the full `{value, display_value}` JSON envelope ServiceNow returned for that row. The API merges `raw` into the response by default; `?slim=1` skips it.

**Indexed columns** — the subset of fields that are extracted from `raw` into typed SQLite columns at build time. Only indexed columns can be used in `?col=value` filters or as `order_by`. See `tables.md`.

**HR gate** — the cookie-based access control over HR-assigned incidents and their child records. See [API.md §3](API.md#3-authentication--authorization-hr-gate).

**Snapshot date** — when the data was pulled from live ServiceNow. Surfaced as `manifest.snapshot_date`. Every response is as-of this date.
