# recon — pre-shutdown reconciliation harness

Proves the deployed SQLite archive is a complete, faithful copy of the live
ServiceNow instance **before the source is decommissioned**. It cross-checks the
archive from several angles — per-table record counts, field completeness,
per-field population, and a deep field-by-field comparison of a random sample of
records against their live source rows — and emits a `PASS` / `WARN` / `FAIL`
verdict that gates shutdown.

It complements the existing verifiers rather than replacing them:

| Tool | Question it answers |
|------|---------------------|
| `bin/verify_sqlite.py` | Is the DB internally consistent with the NDJSON it was built from? |
| `export/verify_export.py` | Did the NDJSON land all the rows the run reported? |
| **`recon`** | Is the deployed DB a faithful copy of **live ServiceNow**, field by field? |

Run `bin/verify_sqlite.py` first (DB↔NDJSON), then `recon` (DB↔live).

## Where it runs

On the host that holds the **deployed** `data/historicalwow.db` and can reach
the source instance — i.e. the production VM, not a laptop copy. The live phase
reuses the exporter's OAuth credentials, so source the exporter `.env` first.
Stdlib-only, Python 3.8+; no dependencies to install.

## Quick start

```sh
cd project

# Offline only — no credentials needed (structural integrity of the DB):
python3 -m recon.reconcile --phase offline

# Full reconciliation (offline + live) — source the exporter .env first:
cd export && set -a && . ./.env && set +a && cd ..
python3 -m recon.reconcile --phase all --sample 200
```

### Smoke test before the full sweep

Validate end-to-end on one small table before making broad live calls:

```sh
python3 -m recon.reconcile --phase all --tables cmn_cost_center --sample 20 \
    --out data/recon_smoke
```

The unit tests run fully offline (no credentials, no live calls):

```sh
python3 -m recon.test_recon
```

## What it checks

**Phase A — offline (reads the DB only):**

1. **count_agreement** — DB row count vs `manifest.json`.
2. **sys_id_integrity** — no empty sys_id (uniqueness is PK-guaranteed).
3. **raw_health** — `raw` parses and carries `{value, display_value}` envelopes.
4. **field_profile** — per-field coverage; flags fields that are always empty.
5. **extractor_fidelity** — re-applies each indexed column's `build_sqlite`
   extractor to `raw`; flags columns that disagree with their extractor (stale
   build) or are empty though their source field is populated (the
   wrong-field-name → silent-NULL bug class).

**Phase B — live (calls the source instance):**

6. **count_parity** — live count *as-of the snapshot watermark*, using the same
   per-table filter the exporter applied, vs the DB count. The verdict count
   is picked per-table: for tables whose `/api/now/stats` count is
   `<= --paginate-count-max` (default 50000), the harness **cursor-paginates
   `/api/now/table`** for a *truly ACL-respecting* count (each page returns
   only rows the OAuth user can read). When the paginated count is less than
   `/stats`, the gap is reported as `acl_filtered_asof` — rows live has but
   the export user cannot read. For larger tables it uses `/table`'s
   `X-Total-Count` header (one call; same as `/stats` — NOT ACL-respecting);
   on HTTP 400/414 (long `tablenameIN<…>` queries like `sys_audit`) it falls
   back to `/stats` with a `stats_fallback` note on any beyond-tolerance FAIL.
   A shortfall within `--count-tolerance-pct` is WARN (rows created during
   the non-instantaneous export); beyond it is FAIL. Records created *after*
   the watermark are reported as `creates_since` (INFO).
7. **field_set** — every field the live record carries is present in the archive.
8. **deep_check** — re-fetches a random sample (`--sample`, default 200) by
   sys_id and classifies each record (see below).
9. **population_parity** — per-field non-empty rate, live vs archive, over the
   sample.

### Deep-check categories

| Category | Meaning | Verdict |
|----------|---------|---------|
| `MATCH` | Same revision, every value identical | PASS |
| `MATCH` (display drift) | Values identical; a referenced record's label changed | WARN |
| `CORRUPTION` | Same revision, a stored value differs | **FAIL** |
| `MISSING_FIELD` | Live record has a field the archive dropped | **FAIL** |
| `STALE_IN_SNAPSHOT` | Live revision is newer but at/before the watermark — the archive missed an in-snapshot update a delta won't repair | **FAIL** |
| `CHANGED_SINCE` | Record edited after the snapshot; immutables still agree | INFO |
| `CHANGED_SINCE` (immutable) | An immutable field (created/number) differs | **FAIL** |
| `DELETED_SINCE` | Source deleted the record after capture | INFO |

## Reading the verdict

- **PASS** — archive matches source (allowing for expected post-snapshot drift).
- **INFO** counts (`DELETED_SINCE`, `CHANGED_SINCE`, deletes/creates-since) are
  *expected* on a snapshot that predates "now"; they never fail a table.
- **WARN** — display-label drift, archive-newer-than-live, or an always-empty
  field not yet confirmed against live. Review, usually benign.
- **FAIL** — real defects: a same-revision value mismatch, a missing field, an
  archive count below what existed at snapshot time, a degenerate extractor, or
  a field populated live but empty in the archive. **Do not shut down** until
  these are understood. Exit code is non-zero on FAIL (`--strict` also fails on
  WARN).

## Output

A JSON report (`recon_report.json`) and a text summary (`recon_summary.txt`) are
written under `--out` (default `data/recon_<timestamp>/`). The report contains
instance-specific data and is written under a `data/` directory, which is
gitignored — **it must never be committed**. The harness refuses to write
outside a `data/` directory unless `--allow-unsafe-out` is passed.

## CLI

```
--phase {offline,live,all}   which checks to run (default: all)
--tables a,b,c               table subset (default: every table in the DB)
--sample N                   records per table for the deep check (default: 200)
--chunk N                    sys_idIN batch size for live re-fetch (default: 50)
--profile-full               full-scan every table for the field profile
--profile-limit N            row threshold above which the profile samples (default: 50000)
--sample-raw N               rows for the raw parse/envelope check (default: 500)
--sample-extractor N         rows for the extractor-fidelity check (default: 5000)
--count-tolerance-pct P      count shortfall within P% is WARN (export-window churn),
                             beyond it FAIL (default: 1.0; use 0 for the final gate)
--paginate-count-max N       tables with /stats count <= N use cursor-paginated /table
                             for a truly ACL-respecting count (default: 50000)
--ignore-fields a,b          extra volatile fields excluded from the corruption check
--db PATH                    archive DB (default: project/data/historicalwow.db)
--out PATH                   report dir (default: <data>/recon_<timestamp>)
--strict                     exit non-zero on WARN as well as FAIL
--allow-unsafe-out           permit writing the report outside a data/ dir
```

## Notes

- The archive is a point-in-time snapshot; the live phase constrains counts to
  `sys_created_on <= <watermark>` and classifies edits/deletes since as expected
  drift, so a recent build reconciles cleanly while a stale one surfaces more
  `CHANGED_SINCE`/`DELETED_SINCE`.
- The append-only tables (`sys_audit`, `sys_journal_field`) compare on
  `sys_created_on`; the filtered tables (`sys_audit`, `sys_journal_field`,
  `sys_attachment`) carry the exporter's `tablenameIN…`/`nameIN…`/`table_nameIN…`
  filter on both the count and the re-fetch.
- `sys_email` bodies are excluded from the compare when the export skipped them.
- Volatile fields that change without bumping `sys_updated_on` (`sys_mod_count`,
  `sys_view_count`, `compiler_build`, `latest_snapshot`, `sizeclass`, plus the
  `sys_user` login-activity fields `last_login`/`last_login_time`/
  `last_login_device`/`failed_attempts`) are excluded from the same-revision
  corruption check. Extend per-instance with `--ignore-fields a,b,c` for custom
  fields that also auto-update without a revision bump (e.g. `u_*` integrations).
- The Phase A "all-empty fields" WARN is informational and is **not** auto-downgraded
  by live (the ~200-row sample can't statistically confirm a field is empty live;
  a sparsely-populated field can be missed by the sample). Curate per-instance:
  once you've verified a field is genuinely unused, silence it with
  `--ignore-fields field_a,field_b`.
- The "should be in the DB" set is `build_sqlite.SCHEMAS`. A SCHEMAS table missing
  from the DB is a FAIL; tables exported to NDJSON but not in SCHEMAS are reported
  as *exported-but-not-built* (informational) — add them to SCHEMAS if you want
  them in the served archive.
- Live calls are sequential and reuse the exporter's retry/backoff; lower
  `--sample` to go gentler on the instance.
- **For the final, frozen pre-shutdown gate** (source quiesced, no new writes),
  run with `--count-tolerance-pct 0 --strict` so any shortfall or warning blocks.
