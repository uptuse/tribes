# Makefile for Tribes Browser Edition
#
# Targets:
#   assets        - fetch assets/tribes_original/ from the assets-large branch (139 MB)
#   clean-assets  - remove assets/tribes_original/ from working tree
#   wasm          - rebuild tribes.wasm via Emscripten (requires emsdk)
#   parse-all-mis - parse every T1 mission file into assets/maps/<name>/canonical.json

.PHONY: assets clean-assets wasm parse-all-mis help

help:
	@echo "make assets        - fetch original Tribes 1 assets (139 MB) from assets-large branch"
	@echo "make clean-assets  - remove fetched assets from working tree"
	@echo "make wasm          - rebuild tribes.wasm (requires emsdk in PATH)"
	@echo "make parse-all-mis - parse all T1 .MIS files into per-map canonical.json"

assets:
	@if [ -d assets/tribes_original ]; then \
	    echo "assets/tribes_original/ already present"; \
	else \
	    echo "Fetching assets-large branch from origin..."; \
	    git fetch origin assets-large:assets-large 2>/dev/null || git fetch origin assets-large; \
	    git checkout assets-large -- assets/tribes_original; \
	    git reset HEAD assets/tribes_original; \
	    echo "Done. assets/tribes_original/ now in working tree (gitignored)."; \
	fi

clean-assets:
	@rm -rf assets/tribes_original
	@echo "assets/tribes_original/ removed from working tree"

wasm:
	@./build.sh

parse-all-mis: assets
	@for mis in assets/tribes_original/base/missions/*.MIS; do \
	    name=$$(basename "$$mis" .MIS | tr '[:upper:]' '[:lower:]'); \
	    mkdir -p "assets/maps/$$name"; \
	    python3 tools/parse_mis.py "$$mis" "assets/maps/$$name/canonical.json"; \
	done
