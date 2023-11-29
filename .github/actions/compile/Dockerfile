# Install dependencies to compile 
FROM alpine:edge
RUN apk add build-base clang17 lld binaryen wasi-sdk

WORKDIR /github/workspace

ENV CC=clang

ENTRYPOINT ["/usr/bin/make"]
