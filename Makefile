test:
	python3 -m pytest_watch app tests -- --ignore=tests/test_utils.test.js -q

test-js:
	cd mobile && npm run test:watch

test-all:
	python3 -m pytest_watch app tests -- --ignore=tests/test_utils.test.js -q & cd mobile && npm run test:watch
