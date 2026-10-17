PYTHON ?= python3
VENV := backend/.venv
BIN := $(VENV)/bin

.PHONY: install dev backend frontend test clean

install: ## Create venv and install backend deps
	$(PYTHON) -m venv $(VENV)
	$(BIN)/pip install -U pip
	$(BIN)/pip install -r backend/requirements-dev.txt

backend: ## Run FastAPI on :8000 with reload
	cd backend && .venv/bin/uvicorn app.main:app --reload --port 8000

frontend: ## Serve static frontend on :5173
	$(PYTHON) -m http.server 5173 --directory frontend

dev: ## Run backend + frontend together
	@trap 'kill 0' INT TERM; \
	$(MAKE) backend & \
	$(MAKE) frontend & \
	wait

test: ## Run backend tests
	cd backend && .venv/bin/pytest -q

clean:
	rm -rf $(VENV) backend/.pytest_cache
