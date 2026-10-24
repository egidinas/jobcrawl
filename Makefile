# Thin wrappers. PROFILE selects the profile folder for every command.
PROFILE ?= profiles/aerospace
PYTHON ?= python3
DATA ?= data
SITE ?= $(DATA)/site
PORT ?= 8000
MODELS ?=

.PHONY: test crawl build map serve demo

test:
	node --test 'crawler/tests/*.test.mjs'

crawl:
	node crawler/run.mjs --profile $(PROFILE)

build:
	$(PYTHON) -m jobcrawl build --profile $(PROFILE) --catalog $(DATA)/catalog.json --out $(SITE)

map:
	$(PYTHON) -m jobcrawl map --profile $(PROFILE)

serve:
	$(PYTHON) scripts/serve.py --data $(SITE) $(if $(MODELS),--models $(MODELS)) --port $(PORT)

demo:
	@echo "demo: the demo data and web app arrive in phases 4 and 5 (python scripts/serve.py --data demo/site)" >&2
	@exit 2
