# syntax=docker/dockerfile:1.7-labs
FROM alpine:edge AS builder
RUN apk add build-base llvm17 clang17 lld binaryen wasi-sdk

WORKDIR /build

COPY --parents --link c_src vendor .
COPY --link build/Makefile .

VOLUME /build/dist

ENTRYPOINT ["make"]
