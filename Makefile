.PHONY: docs verify-docs refresh-swagger-ui help

# Default target — show available recipes.
help:
	@echo 'Targets:'
	@echo '  make docs                  regenerate docs/tables.md and docs/openapi-schemas.yaml from build_sqlite.SCHEMAS'
	@echo '  make verify-docs           validate openapi.yaml and confirm generated docs are in sync with SCHEMAS'
	@echo '  make refresh-swagger-ui    pull the pinned Swagger UI release into docs/swagger-ui/'

# Regenerate the auto-generated docs from SCHEMAS. Run after editing
# build_sqlite.py's SCHEMAS dict. Commits the changed files.
docs:
	python3 project/bin/gen_table_catalog.py

# Used by CI on every PR. Two checks:
#   1. tables.md and openapi-schemas.yaml are in sync with SCHEMAS.
#   2. openapi.yaml is a valid OpenAPI 3.0 document.
verify-docs:
	python3 project/bin/gen_table_catalog.py --check
	python3 -m openapi_spec_validator docs/openapi.yaml
	@# Air-gap guard for the Swagger UI vendoring — refuse external URLs
	@# in the two files we control.
	@if grep -l 'https://' docs/swagger-ui/index.html docs/swagger-ui/swagger-initializer.js >/dev/null 2>&1; then \
		echo 'air-gap guard: external URL found in docs/swagger-ui/{index.html, swagger-initializer.js}' >&2; \
		exit 1; \
	fi
	@echo 'verify-docs: OK'

# Refresh the vendored Swagger UI distribution from a pinned upstream release.
# Pass a tag (`make refresh-swagger-ui VERSION=v5.33.0`) to bump the pin.
refresh-swagger-ui:
	./scripts/refresh-swagger-ui.sh $(VERSION)
