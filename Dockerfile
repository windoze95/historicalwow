# HistoricalWow viewer — static site + nginx.
#
# The container bundles ONLY the viewer (HistoricalWow.html). The exported
# archive (data/) is provided at runtime as a read-only volume mount —
# never baked into the image, never pushed to the registry.
#
# Run on the prod VM:
#   docker run -d --name historicalwow \
#     -p 8080:80 \
#     -v /opt/historicalwow/data:/app/data:ro \
#     ghcr.io/<owner>/historicalwow:latest
#
# Or use docker-compose.yml in this repo as a starting point.

FROM nginx:1.27-alpine

# nginx serves /app as the document root. HistoricalWow.html lives in
# the image; data/ is expected as a bind/volume mount at /app/data.
RUN mkdir -p /app/data \
    && rm /etc/nginx/conf.d/default.conf

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY project/HistoricalWow.html /app/HistoricalWow.html

# Optional symlink so the viewer is reachable as the directory root too.
RUN ln -sf /app/HistoricalWow.html /app/index.html

EXPOSE 80

# Sanity check during build — fails fast if the html didn't copy.
RUN test -s /app/HistoricalWow.html

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
