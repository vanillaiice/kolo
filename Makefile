.PHONY: help install check test typecheck build bundle-client docs dev-mobile dev-desktop dev-server db-up db-down legacy-test legacy-integration
COMPOSE = docker compose -f infrastructure/docker-compose.yml
help: ## List development commands
	@awk -F ':.*?## ' '/^[a-z-]+:.*?## / {printf "  %-20s %s\n", $$1, $$2}' Makefile
install: ## Install the root npm workspace lock
	npm ci
check: ## Check boundaries, types, tests, documentation, and builds
	npm run check
test: ## Run shared-core, contract, server, and desktop adapter tests
	npm test
typecheck: ## Typecheck all active workspaces
	npm run typecheck
build: ## Build shared packages, server, and desktop
	npm run build
bundle-client: ## Verify the mobile app bundles with Metro
	npm run bundle:mobile
docs: ## Regenerate the public TypeScript API reference
	npm run docs:api
dev-mobile: ## Start Expo (requires a native dev build for device verification)
	npm run dev:mobile
dev-desktop: ## Build and launch the Electron scaffold
	npm run dev:desktop
dev-server: ## Build and watch the optional NestJS server scaffold
	npm run dev:server
db-up: ## Start development PostgreSQL on localhost:5433
	$(COMPOSE) up -d --wait
db-down: ## Stop development PostgreSQL while retaining its data
	$(COMPOSE) down
legacy-test: ## Explicitly run archived Go unit tests
	cd archive/legacy-go && go test ./... -race -cover
legacy-integration: db-up ## Explicitly run archived Go PostgreSQL integration tests
	cd archive/legacy-go && KOLO_TEST_DATABASE_URL="postgres://kolo:kolo@localhost:5433/kolo?sslmode=disable" go test ./... -race -cover -count=1
