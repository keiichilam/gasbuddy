.PHONY: scan dashboard check cron health

PORT ?= 20443
HOST ?= 127.0.0.1

scan:
	python3 scan.py

dashboard:
	python3 dashboard.py --host $(HOST) --port $(PORT)

check:
	python3 -m py_compile scan.py dashboard.py gaswatch/*.py
	node --check static/app.js
	python3 -m unittest discover -s tests

cron:
	bash scripts/install_cron.sh

health:
	curl -fsS http://$(HOST):$(PORT)/api/health
