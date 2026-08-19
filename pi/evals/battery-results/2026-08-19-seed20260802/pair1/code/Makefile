CHECK = (cd 'client' && dart test ) && (cd 'server' && go vet ./... && go test ./... )

.PHONY: test lint verify

test:
	$(CHECK)

lint:
	$(CHECK)

verify:
	$(CHECK)
