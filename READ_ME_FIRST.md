# READ ME FIRST — Operational runbook

The viewer reads from a SQLite database built from the NDJSON archive,
not from the NDJSON files directly. Whenever you run the exporter, you
need to **rebuild the DB** before the viewer can see the new rows. Two
or three commands across the lifetime of this archive — ordered below.

> **The DB rebuild step is mandatory after any export run.** The viewer
> queries `/api/*` which reads from `data/historicalwow.db`; if you
> don't rebuild, you'll see stale data even though the NDJSON files have
> the new rows.

---

## NOW: download all attachment file bodies

The table phase finished and skipped attachments by default
(`SN_SKIP_ATTACHMENTS=1`). The metadata for all ~341k attachments is
already on disk; only the binary file bodies still need to come down.
That's `~341k` HTTP GETs at ~1.2/sec ≈ **2-3 days** of wall clock.

Kick this off as soon as you can — it can run alongside the live
ServiceNow instance, and it's fully resumable. **The earlier you start,
the more headroom you have before D-Day.**

```sh
ssh <vm>
cd ~/historicalwow/project/export
set -a; source .env; set +a
SN_TIMEOUT=300 python3 historicalwow_export.py 2>&1 | tee -a export.log
```

**Then update the DB so the viewer sees the new metadata:**

```sh
cd ~/historicalwow
python3 project/bin/build_sqlite.py
```

The first build (the one that produced the current DB) takes 2-3 hours
because it loads ~17 million rows from scratch. **Every subsequent run
is incremental** — the script tracks per-table cursors in a `_build_state`
table and only re-processes rows whose `sys_updated_on` (or `sys_created_on`
for sys_audit / sys_journal_field) is newer than the last build.

So a "few months later" rebuild after a small delta export is **typically
1-3 minutes**, not hours. Safe to run while the container is up — the
viewer picks up the new DB on its next request.

If you ever need to force a full rebuild from scratch (e.g. after fixing
a bug in the indexed-column extractors), pass `--rebuild`:
```sh
python3 project/bin/build_sqlite.py --rebuild
```

**What the export does:**

1. Every table runs a quick incremental delta (minutes total — most
   return zero changes). State watermarks advance as new records land.
2. Then the script enters the attachment-body download phase. You'll
   see lines like:
   ```
   INFO  Downloading attachment bodies — 341640 in metadata. Already-downloaded files are skipped. Ctrl+C is safe.
   INFO    attachments: 25 downloaded, 0 skipped, 0 failed of 341640 (1.2/s, ETA 280000s)
   ```
3. It will run for days. **Ctrl+C is always safe** — already-downloaded
   files are skipped on the next run; partial files are detected by zero
   size and re-fetched.

> Attachment file bodies are served directly from disk by the container,
> so they show up in the viewer's Attachments tab as soon as they're
> downloaded — no DB rebuild needed for new file bodies. Only the table
> metadata (the rows in NDJSON) requires a `build_sqlite.py` rerun.

**Monitor progress** in another terminal:
```sh
tail -f ~/historicalwow/project/export/export.log
# or count downloaded files directly
find ~/historicalwow/project/data/attachments -type f | wc -l
```

**Stop early** if you've waited long enough — the viewer works fine with
partial attachment bodies (the Attachments tab still shows file metadata;
links to undownloaded bodies will 404 in the browser).

---

## D-DAY: final incremental run

After ServiceNow is read-only / decommissioned, run the script one more
time to catch any final-day changes. This is a fast incremental — every
table queries `sys_updated_on >= watermark` (or `sys_created_on` for
audit/journal tables) and only fetches what changed since the last run.

```sh
ssh <vm>
cd ~/historicalwow/project/export
set -a; source .env; set +a
SN_TIMEOUT=300 python3 historicalwow_export.py 2>&1 | tee -a export.log
```

(Same command as above — there's no special D-Day flag. The watermarks
already on disk make it incremental.)

**Then rebuild the DB one final time so the viewer reflects the
final-day deltas:**

```sh
cd ~/historicalwow
python3 project/bin/build_sqlite.py
```

**What to expect:**

- Table phase: 5-10 minutes total (only deltas, even sys_audit will be a
  small fetch since `sys_created_on` only ever moves forward).
- Then attachment bodies pick up where the previous run left off.
  If the previous run already downloaded everything, this phase finishes
  almost instantly with "0 downloaded, 341640 skipped".

**When it's done:**

- Refresh the viewer in your browser (no container restart needed —
  the data dir is a read-only volume mount, the viewer's loader rereads
  the NDJSON files on page load).
- Optional cleanup: `rm ~/historicalwow/project/data/sys_audit.ndjson.flat-salvaged`
  if a salvage file was ever created during a recovery run. (We've
  verified there isn't one currently.)

---

## Where things live

| Thing | Path |
|---|---|
| Cloned repo (code) | `~/historicalwow/` |
| Exported data | `~/historicalwow/project/data/` |
| OAuth credentials | `~/historicalwow/project/export/.env` (chmod 600) |
| Run log | `~/historicalwow/project/export/export.log` |
| Watermarks | `~/historicalwow/project/data/_state.json` |
| Manifest | `~/historicalwow/project/data/manifest.json` |
| Viewer (in browser) | `http://<vm>:8080/` |
| Container | `historicalwow` (run via `docker compose`) |

## If something goes weird

- **Image is stale after a code change**: `cd ~/historicalwow && git pull && docker compose pull && docker compose up -d`
- **Container won't start**: `docker compose logs historicalwow`
- **Viewer shows blank / empty data**: check `_state.json` exists and
  the volume mount is correct: `docker exec historicalwow ls -la /app/data`
- **Export fails authentication**: `.env` may have stale OAuth secret —
  re-generate in ServiceNow → System OAuth → Application Registry →
  HistoricalWow Export → reveal Client Secret → update `.env`.
- **Sanity check archive completeness**: `cd ~/historicalwow/project/export && python3 verify_export.py`

## What NOT to do

- Don't `git push` from this VM — it has the same gitignore as the
  repo, but the data dir is sitting in the working tree and an `-A`
  add could surprise you. Code changes should go through your dev
  machine and the GitHub Actions pipeline.
- Don't commit `.env` anywhere. Ever.
- Don't expose port 8080 to the internet without auth in front. The
  archive contains real PII and ticket descriptions — treat as
  confidential.
