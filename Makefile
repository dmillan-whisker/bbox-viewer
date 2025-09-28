PORT ?= 8000
PUBLIC_DIR := public

.PHONY: run serve help

run: serve

serve: ## Serve the static app (http://localhost:$(PORT))
	@echo "Serving $(PUBLIC_DIR) on http://localhost:$(PORT)"
	@python3 -m http.server $(PORT) --directory $(PUBLIC_DIR)

help: ## Show available targets
	@awk 'BEGIN {FS = "##"} /^[a-zA-Z_-]+:.*##/ {sub(/:.*/, "", $$1); gsub(/^[\t ]+|[\t ]+$$/, "", $$2); printf "\033[36m%-12s\033[0m %s\n", $$1, $$2}' Makefile
