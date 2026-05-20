// Vendored Swagger UI initializer for HistoricalWow.
// Patched from upstream's swagger-initializer.js (Apache-2.0); see SOURCE.md.
// Loads the spec from the same origin — no external fetches.
window.onload = function () {
  window.ui = SwaggerUIBundle({
    url: '/openapi.yaml',
    dom_id: '#swagger-ui',
    deepLinking: true,
    docExpansion: 'list',
    defaultModelsExpandDepth: 1,
    presets: [
      SwaggerUIBundle.presets.apis,
      SwaggerUIStandalonePreset,
    ],
    plugins: [
      SwaggerUIBundle.plugins.DownloadUrl,
    ],
    layout: 'StandaloneLayout',
    tryItOutEnabled: true,
    persistAuthorization: true,
  });
};
