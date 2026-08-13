.PHONY: help test test-backend fuzz-backend lint lint-backend fmt fmt-backend check

# How long each fuzz target runs under `make fuzz-backend`.
FUZZTIME ?= 30s

help: ## Show available targets
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  %-16s %s\n", $$1, $$2}'

check: fmt lint test ## Format, lint, and test everything

test: test-backend ## Run all tests

test-backend: ## Run backend tests with the race detector
	cd backend && go test ./... -race -cover

fuzz-backend: ## Run every fuzz target for FUZZTIME each (default 30s)
	@cd backend && for package in $$(go list ./...); do \
		for target in $$(go test -list='Fuzz.*' $$package | grep '^Fuzz' || true); do \
			echo "==> $$package $$target"; \
			go test $$package -run='^$$' -fuzz="^$$target$$" -fuzztime=$(FUZZTIME) || exit 1; \
		done; \
	done

lint: lint-backend ## Lint everything

lint-backend: ## Vet the backend and check formatting
	cd backend && go vet ./...
	@unformatted=$$(cd backend && gofmt -l .); \
	if [ -n "$$unformatted" ]; then \
		echo "gofmt needed in:"; echo "$$unformatted"; exit 1; \
	fi

fmt: fmt-backend ## Format everything

fmt-backend: ## Apply gofmt to the backend
	cd backend && gofmt -w .
