# Thin wrappers. PROFILE selects the profile folder for every command.
PROFILE ?= profiles/aerospace
PYTHON ?= python3
DATA ?= data
SITE ?= $(DATA)/site
PORT ?= 8000
MODELS ?=
MAP_PYTHON ?= $(PYTHON)

.PHONY: test crawl build embed publish map serve demo

test:
	node --test 'crawler/tests/*.test.mjs'
	$(PYTHON) -m unittest discover tests

crawl:
	node crawler/run.mjs --profile $(PROFILE) --data $(DATA)

build:
	$(PYTHON) -m jobcrawl build --profile $(PROFILE) --catalog $(DATA)/catalog.json --out $(SITE)

embed:
	$(PYTHON) -m jobcrawl embed --site $(SITE) --model-dir models/eg2 --profile $(PROFILE)

publish:
	$(PYTHON) -m jobcrawl publish --site $(SITE) --profile $(PROFILE)

map:
	$(MAP_PYTHON) -m jobcrawl map --site $(SITE) --profile $(PROFILE)
	$(PYTHON) -m jobcrawl publish --site $(SITE) --profile $(PROFILE)

serve:
	$(PYTHON) scripts/serve.py --data $(SITE) $(if $(MODELS),--models $(MODELS)) --port $(PORT)

demo:
	$(PYTHON) scripts/serve.py --data demo/site --port $(PORT)
