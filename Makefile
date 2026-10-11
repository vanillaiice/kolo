.PHONY: help install check test typecheck build bundle-client docs dev-mobile dev-desktop dev-server db-up db-down \
	release release-android release-desktop release-linux release-windows
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
dev-server: ## Build and watch the optional Fastify server
	npm run dev:server
db-up: ## Start development PostgreSQL on localhost:5433
	$(COMPOSE) up -d --wait
db-down: ## Stop development PostgreSQL while retaining its data
	$(COMPOSE) down
release: release-android release-desktop ## Build every platform locally and upload to the shared release
release-android: ## Build the APK and upload it to the shared vX.Y.Z release
	node scripts/release.mjs android
release-desktop: release-linux release-windows ## Build Linux and Windows and upload to the shared vX.Y.Z release
release-linux: ## Build the AppImage and deb and upload them to the shared vX.Y.Z release
	node scripts/release.mjs linux
release-windows: ## Build the Windows installers through wine and upload them to the shared vX.Y.Z release
	node scripts/release.mjs windows
