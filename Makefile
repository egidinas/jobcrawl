# Thin wrappers. PROFILE selects the profile folder for every command.
PROFILE ?= profiles/aerospace
PYTHON ?= python3

.PHONY: test crawl build map demo

test:
	node --test 'crawler/tests/*.test.mjs'

crawl:
	node crawler/run.mjs --profile $(PROFILE)

build:
	$(PYTHON) -m jobcrawl build --profile $(PROFILE)

map:
	$(PYTHON) -m jobcrawl map --profile $(PROFILE)

demo:
	@echo "demo: the demo data and web app arrive in phases 4 and 5 (python scripts/serve.py --data demo/site)" >&2
	@exit 2
