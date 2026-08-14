.PHONY: help check test test-backend test-client test-integration fuzz-backend \
        lint lint-backend lint-client fmt fmt-backend db-up db-down db-reset db-url \
        install-client

# How long each fuzz target runs under `make fuzz-backend`.
FUZZTIME ?= 30s

COMPOSE = docker compose -f infrastructure/docker-compose.yml

# Where the local development database listens. Integration tests create their
# own database on this server, so this points at the default one.
KOLO_TEST_DATABASE_URL ?= postgres://kolo:kolo@localhost:5433/kolo?sslmode=disable

help: ## Show available targets
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  %-18s %s\n", $$1, $$2}'

check: fmt lint test ## Format, lint, and test everything

test: test-backend test-client ## Run unit tests (integration tests skip without a database)

test-backend: ## Run backend tests with the race detector
	cd backend && go test ./... -race -cover

test-client: ## Run client tests against a real SQLite via node:sqlite
	cd apps/mobile && npm test

install-client: ## Install the client's dev dependencies
	cd apps/mobile && npm install

test-integration: db-up ## Start the database and run every test against it
	cd backend && KOLO_TEST_DATABASE_URL="$(KOLO_TEST_DATABASE_URL)" go test ./... -race -cover -count=1

fuzz-backend: ## Run every fuzz target for FUZZTIME each (default 30s)
	@cd backend && for package in $$(go list ./...); do \
		for target in $$(go test -list='Fuzz.*' $$package | grep '^Fuzz' || true); do \
			echo "==> $$package $$target"; \
			go test $$package -run='^$$' -fuzz="^$$target$$" -fuzztime=$(FUZZTIME) || exit 1; \
		done; \
	done

lint: lint-backend lint-client ## Lint everything

lint-backend: ## Vet the backend and check formatting
	cd backend && go vet ./...
	@unformatted=$$(cd backend && gofmt -l .); \
	if [ -n "$$unformatted" ]; then \
		echo "gofmt needed in:"; echo "$$unformatted"; exit 1; \
	fi

lint-client: ## Typecheck the client
	cd apps/mobile && npx tsc --noEmit

fmt: fmt-backend ## Format everything

fmt-backend: ## Apply gofmt to the backend
	cd backend && gofmt -w .

db-up: ## Start the local PostgreSQL and wait until it accepts connections
	$(COMPOSE) up -d --wait

db-down: ## Stop the local PostgreSQL, keeping its data
	$(COMPOSE) down

db-reset: ## Stop the local PostgreSQL and discard its data
	$(COMPOSE) down -v

db-url: ## Print the database URL the integration tests use
	@echo '$(KOLO_TEST_DATABASE_URL)'
