# HistoricalWow

A read-only browser-based archive viewer for ServiceNow data. Pull a complete
snapshot of incidents, change requests, problems, requests, tasks, users,
groups, CIs, journals, audit history, and attachments out of a live
ServiceNow instance — then browse it offline forever, with no live
ServiceNow connection required.

Built for the case where a ServiceNow instance is being decommissioned but
its history needs to remain searchable.

UI branding appears as **HistoricalNow**; codebase-internal name is HistoricalWow.

## What's in this repo

```
project/
├── HistoricalWow.html     # the entire viewer, single-file (React + JSX, served as-is)
├── styles.css             # source for the inlined stylesheet
├── data-mock.js           # fictional seed used when no real export is present
├── data.js                # async loader that hydrates the viewer from data/
├── helpers.jsx · kpalette.jsx · lists.jsx · record.jsx · refs.jsx
├── tweaks-panel.jsx · app.jsx
└── export/
    ├── historicalwow_export.py   # the exporter — OAuth, parallel, resumable, incremental
    ├── test_exporter.py          # 11 unit tests for the merge / state / parallel logic
    ├── probe_counts.py           # estimate per-table row counts before a run
    ├── probe_task_tables.py      # discover task descendants on the source instance
    ├── verify_export.py          # post-run completeness check
    ├── .env.example              # template for OAuth credentials
    └── README.md                 # exporter usage docs

Dockerfile                 # nginx-based static server for the viewer
docker/nginx.conf
docker-compose.yml         # production deploy template (port 8080)
.github/workflows/build.yml  # builds + pushes to ghcr.io on every push to main
```

The exported archive (`data/`) is **never committed** — it stays on whatever
host runs the exporter, and is mounted as a read-only volume at deploy time.

## Architecture

```
┌──────────────────┐  OAuth   ┌─────────────────┐
│  ServiceNow      │ ←──────→ │  exporter       │
│  (live instance) │   REST   │  (Python)       │
└──────────────────┘          └─────────────────┘
                                       │ writes
                                       ▼
                              ┌─────────────────┐
                              │  data/          │  (NDJSON per table +
                              │  *.ndjson       │   manifest.json + state +
                              │  attachments/   │   attachment file bodies)
                              └─────────────────┘
                                       │ mounted read-only
                                       ▼
                              ┌─────────────────┐    HTTP   ┌──────────┐
                              │  nginx          │ ←───────→ │  browser │
                              │  + HistoricalWow│           │          │
                              │  .html (in img) │           └──────────┘
                              └─────────────────┘
                              port 8080 on the VM
```

The viewer is a single-file React app served statically. On load it fetches
the per-table NDJSON files and hydrates `window.HistoricalWowData`. Every
record lookup, journal entry, audit history, and attachment metadata
resolves locally; only attachment file bodies hit the host filesystem.

## API documentation

The same image that serves the viewer also serves a JSON API and an
interactive doc site. Integration teams should start at:

- **Narrative integration guide**: [`docs/API.md`](docs/API.md)
- **OpenAPI 3.0 spec**: [`docs/openapi.yaml`](docs/openapi.yaml) + [`docs/openapi-schemas.yaml`](docs/openapi-schemas.yaml) (auto-generated)
- **Per-table column catalog**: [`docs/tables.md`](docs/tables.md) (auto-generated)
- **ServiceNow glossary**: [`docs/glossary.md`](docs/glossary.md)
- **Interactive docs (running instance)**: `https://<host>/docs` — Swagger UI rendering of the live spec

The per-table catalog regenerates from `project/bin/build_sqlite.py`'s
`SCHEMAS` dict via `make docs`. CI verifies it stays in sync.

## Quick start

### 1. Run the exporter (once, on a machine with ServiceNow access)

```sh
cd project/export
cp .env.example .env
# edit .env with SN_INSTANCE, SN_CLIENT_ID, SN_CLIENT_SECRET, SN_USERNAME, SN_PASSWORD

set -a; source .env; set +a
python3 historicalwow_export.py 2>&1 | tee export.log
```

Subsequent runs are incremental — only changed rows are pulled.

See `project/export/README.md` for the full exporter docs (OAuth setup,
incremental behavior, parallel sys_audit, etc.).

### 2. Verify the archive

```sh
python3 verify_export.py
```

Reports row counts, watermarks, and any tables below the pre-run baseline.

### 3. Deploy the viewer

On the prod VM:

```sh
# Authenticate to ghcr.io once (use a personal access token with read:packages)
echo $GITHUB_TOKEN | docker login ghcr.io -u <username> --password-stdin

# Pull and run
mkdir -p /opt/historicalwow/data
rsync -av /path/from/exporter-machine/data/ /opt/historicalwow/data/
docker compose up -d
# → viewer at http://<vm>:8080/
```

Or with a single command:

```sh
docker run -d --name historicalwow \
  -p 8080:80 \
  -v /opt/historicalwow/data:/app/data:ro \
  --restart unless-stopped \
  ghcr.io/OWNER/historicalwow:latest
```

Edit the `image:` line in `docker-compose.yml` to point at your registry path.

### 4. Updating

Every push to `main` builds a new image and publishes to `ghcr.io`. To roll
the prod VM forward:

```sh
docker compose pull
docker compose up -d
```

The viewer HTML is hot-replaced; the data volume is untouched.

## Development

```sh
# Run the unit tests for the exporter
cd project/export
python3 test_exporter.py

# Build the container locally
docker build -t historicalwow:dev .

# Run with a local data volume
docker run --rm -p 8080:80 \
  -v "$(pwd)/project/data:/app/data:ro" \
  historicalwow:dev
```

To rebuild `HistoricalWow.html` after editing the JSX/CSS sources:

```sh
cd project
{
  echo '<!doctype html><html lang="en"><head>…'
  # see existing build pattern in commit history; the file is currently
  # produced by concatenating styles.css + data-mock.js + data.js + the
  # JSX modules into a single HistoricalWow.html.
} > HistoricalWow.html
```

## Privacy notes

- The exported archive contains real ServiceNow records — incident
  descriptions, user PII, audit history, attachment metadata — and should
  be treated as sensitive company data. Never commit `data/` to source
  control. Never expose port 8080 to the internet without authn.
- The container image bundles only the viewer code; the registry never
  sees the archive.
- `.env` (OAuth creds) lives only on the exporter machine. The fully
  populated archive could be reconstructed from those creds, so treat
  them with the same care as a database password.

## License

Private project. Not licensed for redistribution.
