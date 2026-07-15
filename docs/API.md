# HistoricalWow API

Integration guide for teams consuming the HistoricalWow archive.

> **For interactive try-it-out**, visit `/docs` on any running instance — that page renders this same OpenAPI spec via Swagger UI.
>
> - Machine-readable spec: [`openapi.yaml`](openapi.yaml) (paths) + [`openapi-schemas.yaml`](openapi-schemas.yaml) (per-table row shapes, auto-generated)
> - Per-table column catalog: [`tables.md`](tables.md) (auto-generated)
> - ServiceNow term glossary: [`glossary.md`](glossary.md)

## 1. Overview

HistoricalWow serves a frozen, read-only ServiceNow archive over HTTP. The data was pulled from a live ServiceNow instance once via the exporter, ingested into a SQLite database, and is now served by a small Python process. **No live ServiceNow connection is involved at request time** — every response comes from the local snapshot.

What you get:

- A generated catalog of archived tables (incidents, change requests, users,
  groups, CIs, journal entries, audit history, attachments, catalog metadata,
  server-side logic, asset inventory, and more — see [`tables.md`](tables.md))
- Pagination, exact-match filters on indexed columns, free-text search on text columns, ordering
- Two compact pre-computed lookup blobs for CIs and users
- Cross-table search on task numbers and descriptions
- Per-record journal / audit / attachment metadata
- Attachment file binaries served as plain HTTP downloads

What you do *not* get:

- Writes. Every endpoint is `GET` except the two HR-gate POSTs.
- Real-time ServiceNow data. Everything is as-of the snapshot date — see `/api/manifest`'s `snapshot_date`.
- Arbitrary joins. The generic table API is record-oriented; a few special
  endpoints expose purpose-built joins, while clients handle the rest via the
  `*_lookup` blobs and follow-up requests.

### Audience

This API is intended for internal engineering teams and pre-approved external partners. **The archive contains real ServiceNow data — PII, ticket bodies, audit trails, and attachment binaries — and must be handled as sensitive company data.** See [§3](#3-authentication--authorization-hr-gate) for the access-control model and [§10](#10-footguns) for the most important integration gotchas.

### Versioning

`info.version` in `openapi.yaml` tracks the **API surface**, not the deployed image tag. The deployed instance always serves its current spec at `/openapi.yaml` — that file is authoritative. Version bumps follow:

- **Patch** (`x.y.Z`) — documentation-only changes, error-message wording, internal refactor with no externally observable behavior change.
- **Minor** (`x.Y.0`) — new endpoint, new optional response field, new query parameter, new table added to the catalog.
- **Major** (`X.0.0`) — breaking change: removed endpoint, removed response field, changed response shape, changed status code semantics.

The current spec is **`1.3.0`**. The `/docs` URL itself is a stable name — if it ever has to move (e.g., a viewer page wants `/docs`), the replacement will be `/api-docs` and the old route will redirect for at least one minor bump.

## 2. Quick start

The API is on the same host as the viewer (`/`). All paths are relative.

```sh
# Snapshot metadata — what's in this archive?
curl --compressed -s https://<host>/api/manifest | jq '.snapshot_date, .integrity'

# List 5 most recently updated incidents
curl --compressed -s "https://<host>/api/incident?limit=5&order_by=sys_updated_on&dir=desc" | jq '.rows[] | {number, short_description, state}'

# Incidents whose stored state code is 2 AND priority code is 3
curl --compressed -s "https://<host>/api/incident?state=2&priority=3&limit=200&order_by=sys_updated_on&dir=desc"

# Single record
curl --compressed -s "https://<host>/api/incident/<sys_id>" | jq '.'

# Compact user-name lookup (preferred for joining sys_ids to display names)
curl --compressed -s "https://<host>/api/sys_user_lookup" | jq '. | length'
```

Use `--compressed` (or send `Accept-Encoding: gzip` directly) — list responses are gzipped above 4 KiB.

For the HR-gated subset of the data, see [§3](#3-authentication--authorization-hr-gate). For interactive exploration with a UI, hit `https://<host>/docs` in a browser.

## 3. Authentication & authorization (HR gate)

The API has **no general authentication** — anyone who can reach the listening socket can read non-HR data. **Network controls (firewall, VPN, mTLS at a proxy) are the primary security boundary**; do not place this service on the public internet without something in front.

A subset of the data is gated by an additional cookie-based check called the **HR gate**:

- Incidents whose `assignment_group` is the configured HR group (see `/api/hr-status` → `group_sys_id`) are **hidden** from `/api/incident` list responses, returned as `403 hr_locked` on direct record fetches, and excluded from cross-table search.
- Their child and descendant rows are likewise hidden from generic list
  responses and return `403 hr_locked` on direct record fetches. The generated
  `x-hr-parent-columns` map is the authoritative list of gated tables and
  parent-reference columns; it includes activity, email, task/CI, SLA,
  incident-task, and approval records.
- The attachment file binary route (`/data/attachments/...`) refuses to serve files whose parent record is an HR-assigned incident.

The full list of HR-gated child tables and their parent-reference columns is in [`openapi-schemas.yaml`](openapi-schemas.yaml) under `x-hr-parent-columns`.

### Inspecting state

```sh
curl --compressed -s https://<host>/api/hr-status
# {"enabled": true, "unlocked": false, "group_sys_id": "...", "group_label": "..."}
```

- `enabled: false` means the server has no HR password configured — no gating happens, all rows are visible to everyone. Skip the unlock flow.
- `enabled: true, unlocked: false` means the gate is active and your request would see the filtered view.

### Unlocking

```sh
# POSTs the password and stores the cookie in a jar.
curl -s -X POST -c hr.jar -H 'Content-Type: application/json' \
     -d '{"password":"…"}' \
     https://<host>/api/hr-unlock
# {"ok": true}    -> 200, Set-Cookie: hr_unlock=<token>; Path=/; HttpOnly; SameSite=Strict
# 403 {"error": "wrong password"} on a bad password
# 503 {"error": "gate disabled (HR_UNLOCK_PASSWORD unset)"} if the server has no password configured

# Subsequent reads pass the cookie:
curl --compressed -s -b hr.jar https://<host>/api/incident?limit=5

# Lock back:
curl -s -X POST -b hr.jar https://<host>/api/hr-lock
```

### Properties of the cookie

- **`HttpOnly`** — browser JavaScript cannot read it; only sent automatically by the user agent.
- **`SameSite=Strict`** — not sent on cross-site navigations.
- **`Path=/`** — sent on every same-host request.
- **In-memory only** — tokens live in a process-local set. A server restart invalidates every outstanding cookie. Clients must be prepared to re-unlock on `403 hr_locked`.
- **No expiry** — tokens stay valid until either the process restarts or `POST /api/hr-lock` removes them. Treat them as session-lifetime, not durable.

### Security warnings

> **The gate filters by parent-record sys_id, not by content.** Once you unlock, you can read every HR row — there's no field-level redaction or row-level user binding. A leaked unlock cookie is equivalent to leaking the password until the server restarts.

> **The gate is not an authentication system.** It's a single shared secret that toggles visibility of a known group's records. It is not a substitute for network-level access control, audit logging on the consumer side, or row-level entitlement.

> **PII**. Every response can contain real user names, email addresses, ticket bodies, comments, attachments, etc. Apply the same handling policies you would apply to a database dump.

## 4. Conventions

All conventions below apply to every JSON endpoint unless explicitly overridden in a per-endpoint section.

### 4.1 Request shape

- HTTP method is **`GET`** for every data endpoint. The only `POST`s are `/api/hr-unlock` and `/api/hr-lock`.
- Query parameters are parsed with Python's standard `urllib.parse.parse_qs`. Repeated keys take the **first** value.
- Path templates are documented in [`openapi.yaml`](openapi.yaml).

### 4.2 Pagination

| Parameter | Default | Max | Notes |
| --- | --- | --- | --- |
| `limit` | `200` | `2,000,000` | Hard cap. Pulling a huge `limit` without `Accept-Encoding: gzip` produces a very large body. |
| `offset` | `0` | — | Standard OFFSET. |
| `total` (response) | — | — | Total rows matching the filter, regardless of pagination. |

Use `?slim=1` to skip the `raw` envelope and return only the indexed columns — useful for eager-loading list views that only need a few fields per row.

### 4.3 Filtering

Four filter shapes coexist on `/api/<table>`:

1. **Free-text `q`** — substring match (`LIKE %q%`) against whichever of `number`, `short_description`, `name`, `value`, `ip_address`, `fqdn`, `event_name` exist on the target table (so `cmdb_ci` is searchable by IP / hostname and event tables by event name). A `q` against a table that has none of these columns returns every row (see [§10](#10-footguns)).
2. **Exact-match `?col=value`** — only on **indexed columns**. The full per-table list is in [`tables.md`](tables.md) and machine-readable as `x-filterable-columns` in [`openapi-schemas.yaml`](openapi-schemas.yaml). A comma-separated value is matched as `IN (...)`: `?install_status=7,3` matches either code (this is how one CMDB-metrics option can cover several codes that share a display label).
3. **Range `?col_before=` / `?col_after=`** — on an indexed column, compares with `<` and `>=` respectively (a `_before` bound also excludes empty values, so "no value" isn't treated as an early one). Drives the CI staleness filter, e.g. `cmdb_ci?last_discovered_before=2026-02-01`.
4. **Empty `?col=__empty__`** — matches rows where the indexed column is NULL or the empty string. Use this for analysis drill-throughs such as uncategorized records or records with no assignment group; a literal `?col=` is not equivalent because query parsing drops blank values.

Boolean filters are auto-coerced: `?active=true` matches stored `1`, `?active=false` matches `0`. Other string forms (`Y`/`yes`/`1`-as-string) are **not** coerced — `?active=Y` would attempt to match stored `Y`, which doesn't exist. See [§10](#10-footguns).

Filters on different columns are combined with **AND**. Comma-separated values
within one column are combined as **OR** (`IN (...)`). For example,
`/api/incident?state=2&priority=3` means `state = 2 AND priority = 3`, while
`/api/incident?state=1,2&priority=3` means `(state = 1 OR state = 2) AND
priority = 3`.

Task fields such as `state` and `priority` are filtered by their stored
ServiceNow **codes**, not display labels. To discover the codes and labels in
this snapshot, read `/api/task/metrics/<table>` and use the `value` returned by
entries in `dimensions.state`, `dimensions.priority`, and the other available
dimensions.

Reserved query parameter names — these are pagination / search controls, never filters: `limit`, `offset`, `q`, `order_by`, `dir`, `slim`.

**Unknown columns are silently ignored.** This is the single most important footgun for integrators — see [§10](#10-footguns).

### 4.4 Ordering

| Parameter | Default | Notes |
| --- | --- | --- |
| `order_by` | `sys_id` | Whitelisted against the SQLite table schema. Unknown values fall back to `sys_id`. |
| `dir` | `desc` | `asc` or `desc`. |

The `sys_id` default exists because it's the only column with a guaranteed index on every table. Pass `sys_updated_on` for recent-first task lists, but only on tables that actually have `sys_updated_on` indexed (see [`tables.md`](tables.md)).

### 4.5 Response shape

**Generic table-list endpoints** (`/api/<table>`) return:

```json
{
  "rows":   [ ... ],
  "total":  <int>,
  "limit":  <int>,
  "offset": <int>
}
```

`/api/search` instead returns `{ "rows": [...], "q": "..." }` for a non-empty
search. A missing or blank `q` returns `{ "rows": [] }`. The endpoint is not
paginated and has no `total`, `limit`, or `offset` fields.

**Single-record endpoints** (`/api/<table>/<sys_id>`) always return one merged JSON object. The stored `raw` envelope wins when it has the same key as an indexed column, so that field can retain its ServiceNow `{value, display_value}` object. Single-record routes do not support `slim`.

Some fields inside `raw` use ServiceNow's `{value, display_value}` envelope — `{"value": "abc", "display_value": "Alice"}`. Indexed values were separately extracted at build time using either `_v` for the raw value or `_dv` for the display value; see [`tables.md`](tables.md) for which is which.

On `/api/<table>` list requests, use `?slim=1` to drop `raw` entirely — each row then contains only the indexed scalars plus `sys_id`.

### 4.6 Compression

Most JSON endpoints enable gzip when the request sends `Accept-Encoding: gzip`
and the response is larger than 4 KiB. The four prebuilt lookup endpoints —
`/api/manifest`, `/api/cmdb_ci_lookup`, `/api/sys_user_lookup`, and
`/api/cmdb/metrics` (plus the manifest compatibility alias) — are stored and
served as gzip on every `200` response, regardless of the request header. The
`Content-Encoding: gzip` header signals the representation in either case.

List endpoints can return millions of rows; an uncompressed body of 1 M task
rows is several hundred megabytes. Use a client with gzip support and **always
send `Accept-Encoding: gzip`** (curl's `--compressed` does both).

### 4.7 Caching

Three kinds of cache hints:

- **`ETag` + `If-None-Match`** on the lookup blobs (`/api/manifest`, `/api/cmdb_ci_lookup`, `/api/sys_user_lookup`, `/api/cmdb/metrics`). Clients should cache aggressively and revalidate by sending the previous `ETag` back in `If-None-Match`. A match returns `304 Not Modified` with no body.
- **Cookie-varying task metrics** (`/api/task/metrics/<table>`) return `no-cache, must-revalidate` and vary on both `Accept-Encoding` and `Cookie` because metrics for HR-dependent task tables can change when the gate is unlocked. The server still memoizes locked and unlocked aggregates separately per DB build.
- **`Cache-Control: public, max-age=300`** on list endpoints for tables in `x-cache-5min` (see [`openapi-schemas.yaml`](openapi-schemas.yaml)) when `q` is empty and `limit > 200`. List responses vary on `Accept-Encoding`; HR-cookie-dependent lists are never public and additionally vary on `Cookie`. Other list responses return `Cache-Control: no-cache, must-revalidate`.

If you're operating a forward-proxy or CDN, the lookup blobs are the most valuable to cache.

### 4.8 Errors

All error responses use the envelope:

```json
{ "error": "<message>" }
```

Status codes:

| Status | When |
| --- | --- |
| `400` | Bad request body (e.g., invalid JSON on `/api/hr-unlock`). |
| `403` | HR gate locked (`{"error": "hr_locked"}`), wrong password, or path traversal on attachment URLs (`{"error": "forbidden path"}`). |
| `404` | Unknown route, unknown table, record not found, attachment file missing on disk. |
| `500` | Server-side exception. Should be rare and is logged server-side. |
| `503` | `POST /api/hr-unlock` when the server has no HR password configured (`enabled: false`), or a generic list/record request for an HR-dependent child table while the recursive ancestry indexes are not yet built (`{"error":"hr_schema_pending"}`). |

## 5. Endpoint summary

Compact reference. Full details, request/response shapes, and try-it-out are in `/docs` and [`openapi.yaml`](openapi.yaml).

| Method | Path | Tag | Summary |
| --- | --- | --- | --- |
| GET  | `/api/manifest` | manifest | Build manifest. |
| GET  | `/api/cmdb_ci_lookup` | manifest | Compact CI sys_id → display fields. |
| GET  | `/api/sys_user_lookup` | manifest | Compact user sys_id → display fields. |
| GET  | `/api/cmdb/metrics` | manifest | CMDB overview aggregates (class / status / discovery / staleness / ownership / relationships). |
| GET  | `/api/task/metrics/<table>` | tables | Indexed task distributions, classification coverage, and configured-but-unused choices. |
| GET  | `/api/hr-status` | hr-gate | Gate state. |
| POST | `/api/hr-unlock` | hr-gate | Exchange password for cookie. |
| POST | `/api/hr-lock` | hr-gate | Invalidate cookie. |
| GET  | `/api/whoami` | identity | Caller network identity visible to the server. |
| GET  | `/api/incident` | tables | Incident list with interactive `state` and `priority` filters. |
| GET  | `/api/<table>` | tables | List rows from a table (paginated, filtered, ordered). |
| GET  | `/api/<table>/<sys_id>` | tables | Fetch one row. |
| GET  | `/api/search` | search | Cross-table search on `number` and `short_description`. |
| GET  | `/api/journal/<element_id>` | activity | Journal entries for a parent record. |
| GET  | `/api/audit/<documentkey>` | activity | Audit trail for a parent record. |
| GET  | `/api/attachments/<table_sys_id>` | activity | Attachment metadata for a parent record. |
| GET  | `/api/related/cmdb/<sys_id>` | search | Upstream + downstream CMDB relations for a CI. |
| GET  | `/api/variables/<ritm_sys_id>` | catalog | Catalog variables submitted on an RITM. |
| GET  | `/api/sla-stats/{kind}/{sys_id}` | activity | Incident SLA totals for a user or group. |
| GET  | `/api/flow_reconstruction/<flow_id>` | flows | Decoded raw Flow Designer records. |
| GET  | `/api/service_status?days=<n>` | service-status | Historical outage-status grid. |
| GET  | `/data/manifest.json` | manifest | Compatibility alias for `/api/manifest`. |
| GET  | `/data/attachments/<shard>/<sys_id>/<file>` | files | Attachment file binary. |

## 6. Generic table API

### `GET /api/<table>`

Paginated list. See [§4](#4-conventions) for shared parameters. Returns a `ListEnvelope`.

```sh
# Incidents matching two coded fields (state 2 AND priority 3)
curl --compressed -s "https://<host>/api/incident?state=2&priority=3&limit=50&order_by=sys_updated_on&dir=desc"

# All groups whose name contains 'network'
curl --compressed -s "https://<host>/api/sys_user_group?q=network&limit=200"

# Slim list — sys_id + indexed columns only, no raw envelope
curl --compressed -s "https://<host>/api/cmdb_ci?limit=1000&slim=1"
```

The `<table>` segment must be one of the tables enumerated in [`openapi.yaml`](openapi.yaml) (and [`tables.md`](tables.md)). Unknown tables return `404 {"error": "unknown table: <name>"}`.

During a staged rollout, an allowed table whose NDJSON has not yet been built
into the active database returns an empty `200` list. That response is
indistinguishable from a table that was built successfully but contains no rows;
the manifest and deployment state are the tie-breakers. A single-record request
against the same not-yet-built table returns `404`.

Swagger UI exposes `state`, `priority`, and the shared pagination/search
parameters directly on its dedicated **List incidents** operation. The generic
**List rows from a table** operation cannot render a different set of query
inputs for each table; use [`tables.md`](tables.md) or
`x-filterable-columns` in [`openapi-schemas.yaml`](openapi-schemas.yaml) for the
complete list of accepted filters.

### `GET /api/<table>/<sys_id>`

Single record. `<sys_id>` is the 32-char ServiceNow primary key (1–32 hex characters tolerated by the route). Returns the row as a flat object.

```sh
curl --compressed -s "https://<host>/api/incident/0123456789abcdef0123456789abcdef"
```

Returns:

- `200 <row>` on success
- `403 {"error":"hr_locked"}` if the record is HR-gated and the request lacks a cookie
- `404 {"error":"<table>/<sys_id> not in archive"}` if the row doesn't exist
- `404 {"error":"unknown table: <name>"}` if the table doesn't exist

## 7. Special endpoints

### `/api/manifest`

The exporter's manifest. Contains snapshot date, source instance hostname, per-table row totals, integrity counters (`missing_attachments`, etc.), and the manifest's own SHA-256. Cache aggressively with `ETag`. Returns `404 {"error":"manifest.json missing"}` if the manifest file is absent.

### `/api/cmdb_ci_lookup` and `/api/sys_user_lookup`

Pre-built, in-memory `{sys_id: {<display fields>}}` blobs. Hit them once per session and join client-side instead of firing one `/api/cmdb_ci/<sys_id>` per row you need to display. The blobs are several MB compressed but compress 5–8× under gzip.

### `/api/cmdb/metrics`

Pre-computed CMDB overview aggregates over `cmdb_ci` + `cmdb_rel_ci`: counts by class, operational/install status, discovery source, and last-discovered freshness; ownership coverage (`owned_by` vs `support_group`); and relationship coverage (`connected` vs `orphans`, plus the relationship-type distribution). Cached in-memory per DB build (`ETag`). A dimension is only present once its column is indexed — read `indexed_columns` to see what's available. Distribution entries are `{value, label, count}`, with `value` comma-joined when several codes share a label (so it round-trips through the `IN (...)` filter described in [§4.3](#43-filtering)).

### `/api/task/metrics/<table>`

Returns capability-driven, indexed analysis for a supported task table: state, active status, priority, impact, urgency, contact channel, assignment group, and subtype-specific dimensions such as incident/problem category + subcategory, requested-item catalog item, or change type/model. A field is present in `dimensions` only when the current SQLite build has the supporting extracted column.

Category and subcategory metrics reconcile observed records with active `sys_choice` definitions. `subcategory_pairs` preserves the dependent `(category, subcategory)` relationship; `unused.category` and `unused.subcategory` contain active configured choices with zero observed rows. Distribution `value` fields can be passed directly back to `/api/<table>?<field>=<value>`. The special value `__empty__` drills into missing classification/ownership.

Metrics for supported task tables with HR-dependent rows honor the gate. The endpoint sends `Vary: Accept-Encoding, Cookie` and must be revalidated rather than shared as a public lookup blob.

### `/api/search`

```sh
curl --compressed -s "https://<host>/api/search?q=AD%20password&types=incident,change_request&limit=8"
```

Only searches `number` and `short_description` (not free-text body, not journal entries). Defaults to all task tables; pass `types=` to narrow. Maximum 50 rows per table.

### Activity endpoints (`/api/journal`, `/api/audit`, `/api/attachments`)

Each takes the **parent record's** sys_id (not the activity row's sys_id). All three return `{rows: [...]}` ordered by `sys_created_on` ascending. All three respect the HR gate via the parent reference.

### `/api/related/cmdb/<sys_id>`

```json
{
  "upstream":   [ { ..., "ci": { ..the parent CI's row.. } } ],
  "downstream": [ { ..., "ci": { ..the child CI's row.. } } ]
}
```

Each relation has the connected CI's full row merged in under `ci`. Use this to walk dependency graphs.

### `/api/variables/<ritm_sys_id>`

Rebuilds the form a user submitted when they raised this request item. Joins through `sc_item_option_mtom` → `sc_item_option` → `item_option_new`. Variables are returned in display order (by definition's `order` field, then by question text).

### `/api/whoami`

Returns the caller identity visible to the server:

```json
{"ip":"192.0.2.10","host":"client.example","access_log":true}
```

`ip` and `host` can be `null`. `host` is a best-effort reverse-DNS result, and
`access_log` says whether this server process has access logging configured.
This is identity by network position, not authentication.

### `/api/sla-stats/<user|group>/<sys_id>`

Returns incident SLA totals for one user's `assigned_to` sys_id or one group's
`assignment_group` sys_id:

```json
{"total":42,"breached":3,"by_stage":{"completed":38,"in_progress":4}}
```

When the HR gate is locked, SLA rows belonging to gated incidents are omitted
from these aggregates. Missing source tables produce the same shape with zero
counts rather than an error.

### `/api/flow_reconstruction/<flow_id>`

Returns the archived records behind a Flow Designer flow: the flow header,
triggers, action instances from both generations, and recovered flow-logic
blocks. Base64+gzip configuration fields are decoded into JSON. The response is
intended for inspection and reverse engineering; its nested record fields follow
the stored ServiceNow payload and can vary by flow. Returns `404` when neither a
flow header nor related internals exist, and successful responses are cached for
five minutes.

### `/api/service_status?days=<n>`

Reconstructs the historical service-status grid from `cmdb_ci_outage`. `days`
defaults to 30 and is clamped to 1–180. Because this is a frozen archive, the
window ends on the most recent outage date in the snapshot, not today's date.
Each service contains its worst outage type per day plus the contributing outage
records. The endpoint returns empty arrays and `window: null` when no outage data
is available; populated responses are cached for five minutes.

## 8. Static / attachment routes

### `/data/attachments/<shard>/<sys_id>/<file_name>`

Returns the file body using a content type inferred from the file-name extension,
falling back to `application/octet-stream`. `<shard>` is the lower-cased first
two characters of `<sys_id>`.

- The HR gate checks the parent record before serving — HR-linked attachment bodies are refused with `403 hr_locked`.
- While the gate is enabled and the caller is locked, missing attachment
  metadata is treated as unknown and fails closed with `403 hr_locked` rather
  than exposing an unclassified file body. An unlocked caller can proceed.
- Path traversal segments (`.`, `..`, empty) are rejected with `403 forbidden path` before any sys_id is extracted. A defense-in-depth `relative_to(DATA_DIR)` check runs after path resolution.
- Returns `404` if the file isn't on disk. Attachments may not have been downloaded yet — check the manifest's `integrity.missing_attachments`.

## 9. Table catalog

The full generated list of tables, their indexed columns, types, and tags is in [`docs/tables.md`](tables.md). That file is **auto-generated** from `project/bin/build_sqlite.py`'s `SCHEMAS` dict — do not edit it by hand. To regenerate after a SCHEMAS edit:

```sh
make docs
# or:
python3 project/bin/gen_table_catalog.py
```

CI verifies the file is in sync with SCHEMAS via `python3 project/bin/gen_table_catalog.py --check`. A PR that edits SCHEMAS without regenerating the docs will fail CI.

## 10. Footguns

The patterns that catch new integrators. Read this section before writing your first client.

### Unrecognized filters are silently ignored

```sh
# Typo: 'priorty' instead of 'priority'. No 400 — returns ALL rows.
curl -s "https://<host>/api/incident?priorty=1&limit=5"
```

If a `?col=value` filter names a column that isn't indexed on that table, the server **drops the filter and returns unfiltered rows**. The only way to validate filters from a client is to check the column against `x-filterable-columns` in [`openapi-schemas.yaml`](openapi-schemas.yaml) before sending.

### Boolean filters: `true`/`false`/`1`/`0` only

The server's boolean coercion table is: `'true' → '1'`, `'false' → '0'`. Anything else passes through as a literal:

```sh
?active=true        # OK — matches stored 1
?active=false       # OK — matches stored 0
?active=Y           # WRONG — attempts to match stored 'Y', returns zero rows
?active=yes         # WRONG — same as above
```

### `q` searches whichever text column exists — sometimes none

`q` matches whichever indexed columns exist from this fixed set: `number`,
`short_description`, `name`, `value`, `ip_address`, `fqdn`, and `event_name`.
A `q` against a table with none of them — for example `sys_user_grmember` —
effectively becomes no filter and returns every otherwise-matching row. Check
[`tables.md`](tables.md) before assuming `q` works.

### HR gate hides rows silently

When the gate is locked, list responses **drop HR-linked rows from the result with no indication**. The `total` field reflects the filtered count, not the underlying table size. The viewer or client looking at "fewer rows than expected" needs to hit `/api/hr-status` to know whether the gate is the reason.

Direct record fetches **do** return `403 hr_locked`, so single-record lookups are unambiguous.

### `slim=1` changes the response shape

With `slim=1`, the response only contains indexed columns. Fields you'd find under the `raw` envelope (resolution notes, custom fields, etc.) **disappear**. Don't toggle slim mode based on UI state without making sure consumers can handle both shapes.

### gzip is opt-in on ordinary endpoints

Except for the pre-compressed lookup endpoints listed in §4.6, forgetting
`Accept-Encoding: gzip` makes large responses come back uncompressed — multiple
megabytes per request on big tables. **Always set the header**, or use a client
like curl with `--compressed`.

### HR tokens reset on restart

Cookies issued by `/api/hr-unlock` are stored in a process-local Python set. When the container restarts (deploys, host reboot, container kill), every outstanding cookie becomes invalid. Production clients should re-unlock on `403 hr_locked` rather than caching the cookie indefinitely.

### The `raw` envelope is doubly-shaped

Inside `raw`, fields come from ServiceNow as `{value, display_value}` objects. The indexed columns at the top level of the row are flat scalars — already extracted from the appropriate side of the envelope at build time. So `row.short_description` is a string, but `row.raw.some_unindexed_field` is `{"value": "...", "display_value": "..."}`. This is by design; clients that want consistency should either always read from `raw` (and accept the envelope) or always read flat columns (and accept that some fields aren't there).

### `cache-5min` only kicks in for big list pages

For tables tagged `cache-5min`, `Cache-Control: max-age=300` is set when **both**
`q` is empty **and** `limit > 200`. Exact-match and range filters do not disable
that cache, so a large filtered request can also be cached. Small pages, requests
with `q`, and HR-cookie-dependent lists return `no-cache, must-revalidate`.

### The viewer URL `/` and `/index.html` serve HTML, not JSON

`/` is the viewer. Hitting it programmatically returns the React app's HTML. Use `/api/...` for everything.

### `/data/manifest.json` is a compatibility alias

Returns the same payload as `/api/manifest`. Older clients hit `/data/manifest.json` directly; new clients should prefer `/api/manifest`.

## 11. Glossary

See [`docs/glossary.md`](glossary.md) for ServiceNow term explanations: `sys_id`, `sys_class_name`, the `task` hierarchy, RITM / REQ / SCTASK, CMDB CIs, journal vs audit, value/display_value, and others.

## 12. Changelog

| Version | Date | Notes |
| --- | --- | --- |
| `1.0.0` | 2026-05 | Initial publication. |
| `1.1.0` | 2026-06 | Added `/api/cmdb/metrics` (CMDB overview aggregates). `/api/<table>` gains `?col_before=` / `?col_after=` range filters, comma-separated `IN (...)` filter values, and `ip_address` / `fqdn` in free-text search. `cmdb_ci` indexes additional columns (install status, discovery source, last discovered, support group, category, IP, FQDN). |
| `1.2.0` | 2026-07 | Added `/api/task/metrics/<table>`, task classification/usage analytics, URL-backed task-list facets, and `?col=__empty__` drill-through filters. Task tables add indexed active/impact/urgency/contact-channel fields; incident/problem/change add subtype classification indexes. |
| `1.3.0` | 2026-07 | Documented the existing caller-identity, SLA-statistics, flow-reconstruction, service-status, and manifest-alias routes. Added an explicit Swagger operation for incident `state` / `priority` filtering and synchronized generic filter, search, caching, and table-catalog guidance with the server. |

## 13. Reporting issues

- **Bugs, feature requests** — open an issue against the repo's GitHub Issues.
- **Spec inaccuracies** — same.
- **Security reports** — do **not** file as a public issue. Reach the maintainers via the contact listed in the repo's `info.contact`.

## 14. Attribution

The interactive `/docs` page is rendered by [Swagger UI](https://github.com/swagger-api/swagger-ui), licensed Apache-2.0. The vendored assets and license are at [`docs/swagger-ui/`](swagger-ui/). The vendored version is pinned in [`docs/swagger-ui/VERSION`](swagger-ui/VERSION) and refreshed via `make refresh-swagger-ui`.

The OpenAPI spec is licensed alongside the rest of this repository (private — not for redistribution).
