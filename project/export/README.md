# HistoricalWow — ServiceNow exporter

Pulls a complete archive of incidents, changes, users, groups, CIs, and all the
context the viewer needs into NDJSON files in `../data/`. Attachment file bodies
are downloaded **last**, so canceling with Ctrl+C still leaves you with every
other table intact.

**First run** does a full pull. **Every subsequent run is incremental** —
the script tracks a `sys_updated_on` watermark per table in
`../data/_state.json`, fetches only rows changed since then, and merges them
into the existing NDJSON in place (replace by `sys_id`, append new rows). So
you can run it today, run it again on shutdown day, and only pay for the delta.

Stdlib-only Python 3.8+. No `pip install`.

## 1. Register an OAuth application in ServiceNow

In your ServiceNow instance:

1. **System OAuth → Application Registry** → New → **"Create an OAuth API endpoint for external clients"**.
2. Name it (e.g. `HistoricalWow Export`), save, and copy the generated **Client ID** and **Client Secret**.
3. Leave default token lifetimes unless you have policy reasons to change them.

You also need a service-account user with read access to all the tables below.
A custom role with the necessary read ACLs is cleanest; alternatively use a
read-only admin account.

## 2. Set environment variables

```sh
export SN_INSTANCE="yourcompany.service-now.com"
export SN_CLIENT_ID="abc123…"
export SN_CLIENT_SECRET="def456…"
export SN_USERNAME="historicalwow.export"
export SN_PASSWORD="…"
```

Optional knobs:

| Variable                | Default | Purpose                                                  |
|-------------------------|---------|----------------------------------------------------------|
| `SN_PAGE_SIZE`          | `5000`  | Rows per Table API request                               |
| `SN_RETRIES`            | `5`     | Retry attempts on transient failure (429, 5xx, network)  |
| `SN_TIMEOUT`            | `120`   | Per-request timeout, seconds                             |
| `SN_TABLES`             | (all)   | Comma-separated subset, e.g. `incident,change_request`   |
| `SN_SKIP_ATTACHMENTS`   | `0`     | Set to `1` to skip attachment file bodies entirely       |
| `SN_FULL`               | `0`     | Set to `1` to ignore watermarks and force a full re-pull |
| `SN_MANIFEST_LABEL`     | `export`| Label written into `manifest.json`                       |

## 3. Run

```sh
cd project/export
python3 historicalwow_export.py
```

You'll see per-table progress like:

```
13:42:01 INFO    Exporting incident …
13:42:08 INFO      incident: 5000 rows so far (650/s)
13:42:15 INFO      incident: 10000 rows so far (660/s)
…
13:48:33 INFO      ✓ incident — 420562 rows in 392s
```

## What gets exported

Tables are pulled in this dependency order so a partial run still gives the
viewer a usable, consistent (if incomplete) picture:

1. **Reference**: `sys_choice`, `core_company`, `cmn_department`, `cmn_location`, `cmn_cost_center`
2. **Identity**: `sys_user`, `sys_user_group`, `sys_user_grmember`
3. **CMDB**: `cmdb_ci`, `cmdb_rel_ci`
4. **Records**: `incident`, `change_request`, `incident_task`, `change_task`
5. **Task relationships**: `task_ci`, `task_sla`, `sysapproval_approver`
6. **Activity**: `sys_journal_field`, `sys_audit`
7. **Attachment metadata**: `sys_attachment`
8. **Attachment file bodies** *(LAST — Ctrl+C is safe here)*: stored at `data/attachments/<sys_id>/<file_name>`

Records are written as NDJSON (one row per line). Reference fields use
`sysparm_display_value=all`, so each reference is `{"value": "<sys_id>", "display_value": "<text>"}`
— the viewer's loader unpacks this automatically.

## Cancelling and resuming

- **During the first (full) table export**: Ctrl+C stops the run. The current
  table's partial `.ndjson` is preserved. Re-running picks up where it left off
  via cursor pagination by `sys_id`. After a partial first run, re-running with
  watermarks not yet set still uses the full-pull cursor (no double-fetching).
- **During an incremental run**: each table is processed top-to-bottom; if you
  Ctrl+C between tables, only the tables already finished have their watermarks
  advanced. The next run resumes incremental on the unfinished ones.
- **During attachment download**: Ctrl+C is the explicit "I've waited long
  enough" exit. Every table is already on disk; only attachment bodies are
  partial. Re-running skips bodies already on disk.

## Forcing a re-pull

- **Full re-export of everything**: set `SN_FULL=1`.
- **Full re-export of one table**: delete its `<table>.ndjson` *and* delete the
  table's entry under `"watermarks"` in `_state.json`. Or just delete both
  files for that table; the next run will treat it as new.
- **Reset all state**: delete `_state.json` and the `*.ndjson` files you want
  re-pulled.

## Troubleshooting

- **`OAuth token request failed: HTTP 401`** — wrong client_id/secret, or the
  user can't authenticate. Confirm in ServiceNow → System OAuth.
- **Specific table 404** — the table doesn't exist on this instance (e.g. a
  custom one). The script logs and continues.
- **`HTTP 403`** on a table — the service account lacks read ACL. Grant the
  appropriate role and rerun.
- **Slow `sys_journal_field` / `sys_audit`** — these tables can be the largest
  in the system. Consider running with a narrower scope by setting `SN_TABLES`
  and using the `sys_query` API directly if you need to filter.

## What's in `_state.json`

Per-table high-water marks driving incremental pulls. Don't hand-edit unless
you know what you're doing:

```json
{
  "version": 1,
  "updated_at": "2026-04-30T19:42:11Z",
  "watermarks": {
    "incident":         "2026-04-30 19:31:08",
    "change_request":   "2026-04-30 18:14:55",
    "sys_journal_field":"2026-04-30 19:30:42",
    …
  }
}
```

On the next run, each table is queried with `sys_updated_on>=<watermark>`,
ordered by `sys_updated_on, sys_id`, and the results are merged into the
existing NDJSON file (matching rows replaced, new rows appended). The watermark
then advances to the maximum `sys_updated_on` observed in that delta.

**Note on deletions**: ServiceNow's incremental export pattern catches inserts
and updates but not deletions — a record deleted in ServiceNow remains in your
archive's NDJSON until you re-pull from scratch. For an archive viewer this is
usually the desired behavior (you want history), but flag it if you need
true sync.

## Verifying

After it finishes, `data/manifest.json` summarizes what was pulled:

```json
{
  "label": "export",
  "snapshot_date": "2026-04-30",
  "instance": "yourcompany.service-now.com",
  "captured_at": "2026-04-30T19:42:11Z",
  "tables": [
    {
      "table": "incident",
      "rows": 420562,
      "source_rows": 420562,
      "watermark": "2026-04-30 19:31:08"
    },
    …
  ]
}
```

Open `HistoricalWow.html` from a static server (the viewer uses `fetch('data/…')`
which won't work over `file://`):

```sh
cd project
python3 -m http.server 8000
# then open http://localhost:8000/HistoricalWow.html
```
