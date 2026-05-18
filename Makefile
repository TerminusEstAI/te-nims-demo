MONOREPO ?= $(abspath ../TERMINUSEST-AI)
WEB_SRC   = $(MONOREPO)/DEMOS/severian-fob-web
DATA_SRC  = $(MONOREPO)/DATA/datapacks/moore-ok-tornado-v1/buildings
PDF_SRC   = $(MONOREPO)/DEMOS/severian-ollama/library/pdfs

WEB_FILES = index.html app.js tour.js style.css chain.js voice.js \
            map.js form.js library.js artifacts.js data_tab.js \
            persistence.js config.js sw.js serve.py manifest.json \
            icon-192.png icon-512.png

.PHONY: sync check-secrets push build up judge-up judge-status judge-logs

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
	@echo "=== Syncing bundled starter PDF library ==="
	@mkdir -p web/library/pdfs
	@if [ -d "$(PDF_SRC)" ]; then \
		find web/library/pdfs -mindepth 1 -maxdepth 1 ! -name '.gitkeep' -exec rm -rf {} +; \
		cp -R "$(PDF_SRC)"/. web/library/pdfs/ && echo "  ✓ starter library PDFs"; \
	else \
		echo "  ! PDF source not found: $(PDF_SRC)"; \
	fi
	@echo "=== Done. Review changes with: git diff ==="

# Run security scan — fail if secrets detected
check-secrets:
	@echo "=== Security scan ==="
	@if grep -rn "/Users/[A-Za-z0-9._-]\+\|/home/[A-Za-z0-9._-]\+\|tail854072\|sk-[a-zA-Z0-9]\{20\}\|hf_[a-zA-Z0-9]\{20\}" \
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

# Start the full judge-facing demo stack in the foreground
judge-up:
	docker compose up --build

# Show the current health of the local demo stack
judge-status:
	@echo "=== Containers ==="
	@docker compose ps
	@echo ""
	@echo "=== App status ==="
	@curl -sf http://localhost:8765/status || echo "TE NIMS status endpoint not reachable yet"

# Tail the boot logs that matter for first-run judge installs
judge-logs:
	docker compose logs -f te-nims te-nims-vision te-nims-vision-models
