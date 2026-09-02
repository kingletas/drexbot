# drexbot. Every verb is a make target, and `make help` lists them all.
#
# The Makefile holds no logic: each recipe delegates to npm or to the CLI. A
# target that needs an argument checks for it and prints a usage line rather
# than failing somewhere further in.

SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

PREFIX ?= $(HOME)/bin
NODE_MODULES := node_modules/.package-lock.json

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

$(NODE_MODULES): package.json
	npm install
	@touch $(NODE_MODULES)

.PHONY: setup
setup: $(NODE_MODULES) ## Install dependencies and a browser
	npx playwright install chromium

.PHONY: build
build: $(NODE_MODULES) ## Compile into dist/
	@# tsc never prunes, so a renamed or deleted module stays in dist/ and goes on
	@# being imported and run -- a moved test suite ran twice before this line.
	@rm -rf dist
	npx tsc -p .

.PHONY: check
check: build lint format-check test ## Everything a commit has to pass

.PHONY: lint
lint: $(NODE_MODULES) ## Lint every source file
	npx eslint .

.PHONY: format
format: $(NODE_MODULES) ## Rewrite every file in house style
	npx prettier --write .

.PHONY: format-check
format-check: $(NODE_MODULES) ## Fail when a file is not in house style
	npx prettier --check .

.PHONY: test
test: build ## Unit-test drexbot, under a runner that is not the harness
	@# Node's own discovery, not a path: passing `dist/tests/` worked on Node 20
	@# and is read as a module name from 22 onward, which fails before a test runs.
	node --test

.PHONY: install
install: build ## Put drexbot on PATH
	@mkdir -p $(PREFIX)
	@printf '#!/usr/bin/env bash\nexec %s/bin/drexbot "$$@"\n' '$(CURDIR)' > $(PREFIX)/drexbot
	@chmod +x $(PREFIX)/drexbot
	@echo "installed $(PREFIX)/drexbot -> $(CURDIR)/bin/drexbot"

.PHONY: baseline
baseline: build ## Ask the store what is in it — make baseline [url=https://...]
	./bin/drexbot baseline --target magento $(if $(url),--url $(url))

.PHONY: magento
magento: build ## Run every storefront suite against the store
	./bin/drexbot run --target magento

.PHONY: probe
probe: build ## Report whether the suite could drive this site, judging nothing
	./bin/drexbot probe --target magento

.PHONY: coverage
coverage: build ## Check the sign-off sheet against the checks that fill it
	./bin/drexbot coverage

.PHONY: clean
clean: ## Remove build output and run artefacts
	rm -rf dist results

.PHONY: distclean
distclean: clean ## Also remove installed dependencies
	rm -rf node_modules
