# HistoricalWow viewer — single-process Python server (stdlib only) that
# serves the static HTML viewer plus a thin /api/* JSON layer over a SQLite
# DB built from the NDJSON archive.
#
# The container bundles ONLY the viewer + server code. The exported archive
# (data/) — including the SQLite DB — is provided at runtime as a read-only
# volume mount. Build the DB on the host:
#
#   cd <repo>
#   python3 project/bin/build_sqlite.py
#
# Then run:
#
#   docker compose up -d   # mounts ./project/data → /app/data:ro

FROM python:3.12-alpine

WORKDIR /app

# wget is needed for HEALTHCHECK (alpine python image doesn't include curl/wget)
RUN apk add --no-cache wget && \
    mkdir -p /app/data /app/bin

COPY project/HistoricalWow.html /app/HistoricalWow.html
COPY project/bin/server.py      /app/bin/server.py

# Symlink so the viewer is reachable as the directory root.
RUN ln -sf /app/HistoricalWow.html /app/index.html && \
    test -s /app/HistoricalWow.html && \
    test -s /app/bin/server.py

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1

CMD ["python3", "/app/bin/server.py"]
