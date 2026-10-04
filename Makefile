# Common tasks. `make` lists them. Sticks to GNU Make 3.81, the version macOS ships.

.DEFAULT_GOAL := help
.PHONY: help install start test sync build up down logs test-docker publish

help: ## List the targets
	@awk 'BEGIN { FS = ":.*## " } /^[a-z-]+:.*## / { printf "  %-12s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

node_modules: package.json package-lock.json
	npm ci
	@touch node_modules

install: node_modules ## Install the test dependencies

start: ## Run the server with Node on http://localhost:8080
	npm start

test: node_modules ## Run the browser tests
	npm test

sync: ## Copy the GURPS sheet from ../roll20-character-sheets
	npm run sync

build: ## Build the Docker image
	docker compose build

up: ## Build and start the container (port: GURPS_PORT, default 8080)
	docker compose up -d --wait
	@echo "Running at http://localhost:$$(docker compose port gurps-sheet 8080 | sed 's/.*://')"

down: ## Stop the container
	docker compose down

logs: ## Follow the container logs
	docker compose logs -f

test-docker: node_modules ## Build the image and run the browser tests against it, like CI
	scripts/test-docker.sh

publish: ## Release the next version and publish its image: make publish [VERSION=x.y.z]
	scripts/publish.sh $(VERSION)
