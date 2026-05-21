# Vendored marked.js

The files in this directory power the markdown-rendering view served at `/docs/<file>.md` (when accessed from a browser). `marked.min.js` is vendored from the upstream marked release and is licensed MIT — see [`LICENSE`](LICENSE).

## Source

- Repository: https://github.com/markedjs/marked
- Version: see [`VERSION`](VERSION)
- Origin file: the UMD build from npm's `marked` package, renamed to `marked.min.js` for parity with our `docs/swagger-ui/` layout. (GitHub release tarballs ship only source; the npm tarball is the only place the prebuilt artifact lives.)

## What's vendored

- `marked.min.js` — UMD build of marked, exposes `marked` as a global when loaded via `<script>`. Used by `viewer.html` to render markdown client-side.
- `viewer.html` — the wrapper page served when a browser requests `/docs/<file>.md`. Reads `window.location.pathname`, fetches the same URL with `Accept: text/markdown` to bypass content negotiation, and renders via marked.

## Refresh procedure

```sh
# (no automation yet — done by hand)
curl -sL -o /tmp/marked.tgz https://registry.npmjs.org/marked/-/marked-<VERSION>.tgz
tar -xzf /tmp/marked.tgz -C /tmp
cp /tmp/package/lib/marked.umd.js docs/md-viewer/marked.min.js
cp /tmp/package/LICENSE docs/md-viewer/LICENSE
echo "v<VERSION>" > docs/md-viewer/VERSION
```

If marked ever ships an outright minified build (`marked.umd.min.js`), prefer that.

## Air-gap guarantee

`viewer.html` makes one `fetch()` call: same-origin to the markdown file's own URL. No external requests at runtime. The bundled `marked.min.js` contains URL strings only in inline error messages and license headers — none are fetched. The CI air-gap grep on the two HTML/init files we control (`docs/swagger-ui/index.html`, `docs/swagger-ui/swagger-initializer.js`) covers the Swagger UI side; this directory's bundle is exempt for the same reason.
