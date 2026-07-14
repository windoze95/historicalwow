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

- 70 tables (incidents, change requests, users, groups, CIs, journal entries, audit history, attachments, catalog metadata, server-side logic, asset inventory — see [`tables.md`](tables.md))
- Pagination, exact-match filters on indexed columns, free-text search on text columns, ordering
- Two compact pre-computed lookup blobs for CIs and users
- Cross-table search on task numbers and descriptions
- Per-record journal / audit / attachment metadata
- Attachment file binaries served as plain HTTP downloads

What you do *not* get:

- Writes. Every endpoint is `GET` except the two HR-gate POSTs.
- Real-time ServiceNow data. Everything is as-of the snapshot date — see `/api/manifest`'s `snapshot_date`.
- Joins. The API is record-oriented; clients perform their own joins via the `*_lookup` blobs and follow-up requests.

### Audience

This API is intended for internal engineering teams and pre-approved external partners. **The archive contains real ServiceNow data — PII, ticket bodies, audit trails, and attachment binaries — and must be handled as sensitive company data.** See [§3](#3-authentication--authorization-hr-gate) for the access-control model and [§10](#10-footguns) for the most important integration gotchas.

### Versioning

`info.version` in `openapi.yaml` tracks the **API surface**, not the deployed image tag. The deployed instance always serves its current spec at `/openapi.yaml` — that file is authoritative. Version bumps follow:

- **Patch** (`x.y.Z`) — documentation-only changes, error-message wording, internal refactor with no externally observable behavior change.
- **Minor** (`x.Y.0`) — new endpoint, new optional response field, new query parameter, new table added to the catalog.
- **Major** (`X.0.0`) — breaking change: removed endpoint, removed response field, changed response shape, changed status code semantics.

The current spec is **`1.2.0`**. The `/docs` URL itself is a stable name — if it ever has to move (e.g., a viewer page wants `/docs`), the replacement will be `/api-docs` and the old route will redirect for at least one minor bump.

## 2. Quick start

The API is on the same host as the viewer (`/`). All paths are relative.

```sh
# Snapshot metadata — what's in this archive?
curl --compressed -s https://<host>/api/manifest | jq '.snapshot_date, .integrity'

# List 5 most recently updated incidents
curl --compressed -s "https://<host>/api/incident?limit=5&order_by=sys_updated_on&dir=desc" | jq '.rows[] | {number, short_description, state}'

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
- Their child rows — entries in `sys_journal_field`, `sys_audit`, `sys_attachment`, `task_ci`, `task_sla`, and `incident_task` whose parent reference points at an HR-assigned incident — are likewise hidden from generic list responses and 403 on direct record fetches.
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

1. **Free-text `q`** — substring match (`LIKE %q%`) against whichever of `number`, `short_description`, `name`, `value`, `ip_address`, `fqdn` exist on the target table (so `cmdb_ci` is searchable by IP / hostname). A `q` against a table that has none of these columns returns every row (see [§10](#10-footguns)).
2. **Exact-match `?col=value`** — only on **indexed columns**. The full per-table list is in [`tables.md`](tables.md) and machine-readable as `x-filterable-columns` in [`openapi-schemas.yaml`](openapi-schemas.yaml). A comma-separated value is matched as `IN (...)`: `?install_status=7,3` matches either code (this is how one CMDB-metrics option can cover several codes that share a display label).
3. **Range `?col_before=` / `?col_after=`** — on an indexed column, compares with `<` and `>=` respectively (a `_before` bound also excludes empty values, so "no value" isn't treated as an early one). Drives the CI staleness filter, e.g. `cmdb_ci?last_discovered_before=2026-02-01`.
4. **Empty `?col=__empty__`** — matches rows where the indexed column is NULL or the empty string. Use this for analysis drill-throughs such as uncategorized records or records with no assignment group; a literal `?col=` is not equivalent because query parsing drops blank values.

Boolean filters are auto-coerced: `?active=true` matches stored `1`, `?active=false` matches `0`. Other string forms (`Y`/`yes`/`1`-as-string) are **not** coerced — `?active=Y` would attempt to match stored `Y`, which doesn't exist. See [§10](#10-footguns).

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

`/api/search` instead returns `{ "rows": [...], "q": "..." }`; it is not paginated and has no `total`, `limit`, or `offset` fields.

**Single-record endpoints** (`/api/<table>/<sys_id>`) always return one merged JSON object. The stored `raw` envelope wins when it has the same key as an indexed column, so that field can retain its ServiceNow `{value, display_value}` object. Single-record routes do not support `slim`.

Some fields inside `raw` use ServiceNow's `{value, display_value}` envelope — `{"value": "abc", "display_value": "Alice"}`. Indexed values were separately extracted at build time using either `_v` for the raw value or `_dv` for the display value; see [`tables.md`](tables.md) for which is which.

On `/api/<table>` list requests, use `?slim=1` to drop `raw` entirely — each row then contains only the indexed scalars plus `sys_id`.

### 4.6 Compression

Send `Accept-Encoding: gzip` to enable gzip on responses larger than 4 KiB. The `Content-Encoding: gzip` response header signals when it's been applied. List endpoints can return millions of rows; an uncompressed body of 1 M task rows is several hundred megabytes. **Always set `Accept-Encoding: gzip`** unless your client genuinely can't decompress.

### 4.7 Caching

Two kinds of cache hints:

- **`ETag` + `If-None-Match`** on the lookup blobs (`/api/manifest`, `/api/cmdb_ci_lookup`, `/api/sys_user_lookup`, `/api/cmdb/metrics`). Clients should cache aggressively and revalidate by sending the previous `ETag` back in `If-None-Match`. A match returns `304 Not Modified` with no body.
- **Cookie-varying task metrics** (`/api/task/metrics/<table>`) return `no-cache, must-revalidate` and vary on both `Accept-Encoding` and `Cookie` because incident totals can change when the HR gate is unlocked. The server still memoizes locked and unlocked aggregates separately per DB build.
- **`Cache-Control: public, max-age=300`** on list endpoints for tables in `x-cache-5min` (see [`openapi-schemas.yaml`](openapi-schemas.yaml)) when `q` is empty and `limit > 200`. All JSON responses vary on `Accept-Encoding`; HR-cookie-dependent lists are never public and additionally vary on `Cookie`. Other list responses return `Cache-Control: no-cache, must-revalidate`.

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
| `503` | `POST /api/hr-unlock` when the server has no HR password configured (`enabled: false`). |

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
| GET  | `/api/<table>` | tables | List rows from a table (paginated, filtered, ordered). |
| GET  | `/api/<table>/<sys_id>` | tables | Fetch one row. |
| GET  | `/api/search` | search | Cross-table search on `number` and `short_description`. |
| GET  | `/api/journal/<element_id>` | activity | Journal entries for a parent record. |
| GET  | `/api/audit/<documentkey>` | activity | Audit trail for a parent record. |
| GET  | `/api/attachments/<table_sys_id>` | activity | Attachment metadata for a parent record. |
| GET  | `/api/related/cmdb/<sys_id>` | search | Upstream + downstream CMDB relations for a CI. |
| GET  | `/api/variables/<ritm_sys_id>` | catalog | Catalog variables submitted on an RITM. |
| GET  | `/data/attachments/<shard>/<sys_id>/<file>` | files | Attachment file binary. |

## 6. Generic table API

### `GET /api/<table>`

Paginated list. See [§4](#4-conventions) for shared parameters. Returns a `ListEnvelope`.

```sh
# 50 highest-priority open incidents
curl --compressed -s "https://<host>/api/incident?priority=1&state=2&limit=50&order_by=sys_updated_on&dir=desc"

# All groups whose name contains 'network'
curl --compressed -s "https://<host>/api/sys_user_group?q=network&limit=200"

# Slim list — sys_id + indexed columns only, no raw envelope
curl --compressed -s "https://<host>/api/cmdb_ci?limit=1000&slim=1"
```

The `<table>` segment must be one of the tables enumerated in [`openapi.yaml`](openapi.yaml) (and [`tables.md`](tables.md)). Unknown tables return `404 {"error": "unknown table: <name>"}`.

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

The exporter's manifest. Contains snapshot date, source instance hostname, per-table row totals, integrity counters (`missing_attachments`, etc.), and the manifest's own SHA-256. Cache aggressively with `ETag`.

### `/api/cmdb_ci_lookup` and `/api/sys_user_lookup`

Pre-built, in-memory `{sys_id: {<display fields>}}` blobs. Hit them once per session and join client-side instead of firing one `/api/cmdb_ci/<sys_id>` per row you need to display. The blobs are several MB compressed but compress 5–8× under gzip.

### `/api/cmdb/metrics`

Pre-computed CMDB overview aggregates over `cmdb_ci` + `cmdb_rel_ci`: counts by class, operational/install status, discovery source, and last-discovered freshness; ownership coverage (`owned_by` vs `support_group`); and relationship coverage (`connected` vs `orphans`, plus the relationship-type distribution). Cached in-memory per DB build (`ETag`). A dimension is only present once its column is indexed — read `indexed_columns` to see what's available. Distribution entries are `{value, label, count}`, with `value` comma-joined when several codes share a label (so it round-trips through the `IN (...)` filter described in [§4.3](#43-filtering)).

### `/api/task/metrics/<table>`

Returns capability-driven, indexed analysis for a supported task table: state, active status, priority, impact, urgency, contact channel, assignment group, and subtype-specific dimensions such as incident/problem category + subcategory, requested-item catalog item, or change type/model. A field is present in `dimensions` only when the current SQLite build has the supporting extracted column.

Category and subcategory metrics reconcile observed records with active `sys_choice` definitions. `subcategory_pairs` preserves the dependent `(category, subcategory)` relationship; `unused.category` and `unused.subcategory` contain active configured choices with zero observed rows. Distribution `value` fields can be passed directly back to `/api/<table>?<field>=<value>`. The special value `__empty__` drills into missing classification/ownership.

Incident and incident-task totals honor the HR gate. The endpoint sends `Vary: Accept-Encoding, Cookie` and must be revalidated rather than shared as a public lookup blob.

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

## 8. Static / attachment routes

### `/data/attachments/<shard>/<sys_id>/<file_name>`

Returns the file body as `application/octet-stream` (or the original `Content-Type` if recognized — see the MIME table in the source). `<shard>` is the lower-cased first two characters of `<sys_id>`.

- The HR gate checks the parent record before serving — HR-linked attachment bodies are refused with `403 hr_locked`.
- Path traversal segments (`.`, `..`, empty) are rejected with `403 forbidden path` before any sys_id is extracted. A defense-in-depth `relative_to(DATA_DIR)` check runs after path resolution.
- Returns `404` if the file isn't on disk. Attachments may not have been downloaded yet — check the manifest's `integrity.missing_attachments`.

## 9. Table catalog

The full list of 70 tables, their indexed columns, types, and tags is in [`docs/tables.md`](tables.md). That file is **auto-generated** from `project/bin/build_sqlite.py`'s `SCHEMAS` dict — do not edit it by hand. To regenerate after a SCHEMAS edit:

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

`q` matches `number`, `short_description`, `name`, or `value` — but only on tables that actually have those columns. A `q` against `sys_user` (no `number`/`short_description`/`name`/`value` indexed — `name` exists but the table has `user_name` not `name`) effectively becomes no filter. Check [`tables.md`](tables.md) before assuming `q` works.

### HR gate hides rows silently

When the gate is locked, list responses **drop HR-linked rows from the result with no indication**. The `total` field reflects the filtered count, not the underlying table size. The viewer or client looking at "fewer rows than expected" needs to hit `/api/hr-status` to know whether the gate is the reason.

Direct record fetches **do** return `403 hr_locked`, so single-record lookups are unambiguous.

### `slim=1` changes the response shape

With `slim=1`, the response only contains indexed columns. Fields you'd find under the `raw` envelope (resolution notes, custom fields, etc.) **disappear**. Don't toggle slim mode based on UI state without making sure consumers can handle both shapes.

### gzip is opt-in

If you forget `Accept-Encoding: gzip`, large responses come back uncompressed — multiple megabytes per request on big tables. **Always set the header**, or use a client like curl with `--compressed`.

### HR tokens reset on restart

Cookies issued by `/api/hr-unlock` are stored in a process-local Python set. When the container restarts (deploys, host reboot, container kill), every outstanding cookie becomes invalid. Production clients should re-unlock on `403 hr_locked` rather than caching the cookie indefinitely.

### The `raw` envelope is doubly-shaped

Inside `raw`, fields come from ServiceNow as `{value, display_value}` objects. The indexed columns at the top level of the row are flat scalars — already extracted from the appropriate side of the envelope at build time. So `row.short_description` is a string, but `row.raw.some_unindexed_field` is `{"value": "...", "display_value": "..."}`. This is by design; clients that want consistency should either always read from `raw` (and accept the envelope) or always read flat columns (and accept that some fields aren't there).

### `cache-5min` only kicks in for big list pages

`Cache-Control: max-age=300` is set when **both** `q` is empty **and** `limit > 200`. A small or filtered list response still returns `no-cache, must-revalidate`. This is intentional — filtered queries are usually for live UI, while large unfiltered dumps are safe to cache.

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

## 13. Reporting issues

- **Bugs, feature requests** — open an issue against the repo's GitHub Issues.
- **Spec inaccuracies** — same.
- **Security reports** — do **not** file as a public issue. Reach the maintainers via the contact listed in the repo's `info.contact`.

## 14. Attribution

The interactive `/docs` page is rendered by [Swagger UI](https://github.com/swagger-api/swagger-ui), licensed Apache-2.0. The vendored assets and license are at [`docs/swagger-ui/`](swagger-ui/). The vendored version is pinned in [`docs/swagger-ui/VERSION`](swagger-ui/VERSION) and refreshed via `make refresh-swagger-ui`.

The OpenAPI spec is licensed alongside the rest of this repository (private — not for redistribution).
