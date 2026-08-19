# Canonical check for this repo: Dart client tests, then Go vet + tests.
CHECK = (cd 'client' && dart test ) && (cd 'server' && go vet ./... && go test ./... )

test:
	$(CHECK)

lint:
	$(CHECK)

verify:
	$(CHECK)

.PHONY: test lint verify
