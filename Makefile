.PHONY: help setup format format-write lint typecheck test coverage security quick all try

help: ## List project commands
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "%-16s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: ## Install pinned dependencies and versioned Git hooks
	npm ci
	git config core.hooksPath .githooks

format: ## Check formatting
	npm run format

format-write: ## Apply formatting
	npm run format:write

lint: ## Run static lint checks
	npm run lint

typecheck: ## Check TypeScript types
	npm run typecheck

test: ## Run unit tests
	npm test

coverage: ## Run tests and enforce coverage budget
	npm run test:coverage

security: ## Scan dependencies for high-severity vulnerabilities
	npm run security

quick: format lint typecheck test ## Run pre-commit checks

all: format lint typecheck coverage security ## Run complete local/CI gate

try: ## Load extension in Pi for an interactive smoke test
	pi -e ./extensions/index.ts
