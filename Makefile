MONOREPO ?= $(HOME)/AI/TERMINUSEST-AI
WEB_SRC   = $(MONOREPO)/DEMOS/severian-fob-web
DATA_SRC  = $(MONOREPO)/DATA/datapacks/moore-ok-tornado-v1/buildings

WEB_FILES = index.html app.js tour.js style.css chain.js voice.js \
            map.js form.js library.js artifacts.js data_tab.js \
            persistence.js config.js sw.js serve.py manifest.json \
            icon-192.png icon-512.png

.PHONY: sync check-secrets push build

# Pull latest demo code from the monorepo, check for secrets, commit, push
sync: check-secrets
	@echo "=== Syncing web files from monorepo ==="
	@for f in $(WEB_FILES); do \
		if [ -f "$(WEB_SRC)/$$f" ]; then \
			cp "$(WEB_SRC)/$$f" web/$$f && echo "  ✓ $$f"; \
		fi; \
	done
	@echo "=== Syncing doctrine database ==="
	@[ -f "$(WEB_SRC)/../severian-ollama/chunks.db" ] && \
		cp "$(WEB_SRC)/../severian-ollama/chunks.db" web/chunks.db && echo "  ✓ chunks.db"
	@echo "=== Done. Review changes with: git diff ==="

# Run security scan — fail if secrets detected
check-secrets:
	@echo "=== Security scan ==="
	@if grep -rn "/Users/tmancino\|/home/tmancino\|tail854072\|sk-[a-zA-Z0-9]\{20\}\|hf_[a-zA-Z0-9]\{20\}" \
		web/ --include="*.py" --include="*.js" 2>/dev/null; then \
		echo "SECURITY: Personal paths or secrets detected — aborting." && exit 1; \
	fi
	@echo "  ✓ Clean"

# Commit and push to GitHub
push:
	git add -A
	git commit -m "chore: sync demo code from monorepo $$(date +%Y-%m-%d)"
	git push origin main

# Full release: sync + commit + push
release: sync push
	@echo "=== Released to github.com/terminus-est-ai/te-nims-demo ==="

# Build Docker image locally to test
build:
	docker compose build

# Start locally
up:
	docker compose up
