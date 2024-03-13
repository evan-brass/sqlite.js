FROM alpine:edge AS builder
RUN apk add build-base clang17 lld binaryen wasi-sdk deno

WORKDIR /scratch

ADD --link . .

CMD ["deno", "task", "build"]
