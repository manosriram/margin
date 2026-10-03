.PHONY: build run test clean

build:
	go build -o margin .

run: build
	./margin $(PDF)

test:
	go test ./...
	node test/md.test.mjs

clean:
	rm -f margin
