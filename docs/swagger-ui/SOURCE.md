# Vendored Swagger UI

The files in this directory come from the upstream Swagger UI distribution and are licensed under Apache-2.0. See [`LICENSE`](LICENSE).

## Source

- Repository: https://github.com/swagger-api/swagger-ui
- Version: see [`VERSION`](VERSION)
- Release tarball:
  `https://github.com/swagger-api/swagger-ui/archive/refs/tags/<VERSION>.tar.gz`

## What's vendored vs patched

Vendored verbatim from upstream `dist/`:

- `swagger-ui.css`
- `swagger-ui-bundle.js`
- `swagger-ui-standalone-preset.js`
- `index.css`
- `favicon-16x16.png`
- `favicon-32x32.png`

Patched copies (do not overwrite blindly when refreshing — the refresh script preserves them):

- `index.html` — title changed to "HistoricalWow API — Interactive Docs"; upstream's `<!-- ... -->` build comment removed; loads our patched `swagger-initializer.js` from a relative path.
- `swagger-initializer.js` — `url` points at `/openapi.yaml` (same origin) instead of the petstore demo; `deepLinking`, `tryItOutEnabled`, `persistAuthorization` enabled.

## Refresh procedure

```sh
make refresh-swagger-ui
# or:
./scripts/refresh-swagger-ui.sh
```

The script refuses to overwrite `index.html` and `swagger-initializer.js` automatically — bump them by hand to pick up any upstream changes. After running, commit the result.

## Air-gap guarantee

`index.html` and `swagger-initializer.js` make **no external network requests**. They only fetch `/openapi.yaml` (same origin). CI verifies this with a grep against `index.html` and `swagger-initializer.js` for any `https://` references.

The bundled JS files (`swagger-ui-bundle.js`, `swagger-ui-standalone-preset.js`) contain inline URL strings — JSON-schema namespace IDs, RFC references in error messages, W3C SVG namespace, etc. None of these are runtime fetches; the grep guard is intentionally scoped to the two HTML/init files we control.

## License

The vendored upstream files are Apache-2.0 — verbatim copy of upstream's [`LICENSE`](LICENSE).
