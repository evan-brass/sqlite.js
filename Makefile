CC = wasi-sdk-20.0/bin/clang
CFLAGS_COMMON = -D_HAVE_SQLITE_CONFIG_H -Iinclude -Wl,--export-dynamic,--export=malloc,--export=free,--export=realloc,--export=strlen
WOFLAGS_COMMON = --asyncify
ifdef RELEASE
CFLAGS = -Os $(CFLAGS_COMMON)
WOFLAGS = -O4 $(WOFLAGS_COMMON)
else
CFLAGS = -Os -g $(CFLAGS_COMMON)
WOFLAGS = $(WOFLAGS_COMMON) -g --pass-arg=asyncify-asserts
endif

.PHONY = all clean


all: sqlite3.async.wasm

sqlite3.wasm: c_src/main.c vendor/sqlite3.c include/sqlite_cfg.h
	$(CC) $(CFLAGS) -o dist/$@ c_src/*.c
	wasm2wat dist/$@ | grep -E "\(import|\(export"
	gzip -f -k dist/$@

# TODO: SQLite uses function pointers a lot which results in asyncify transforming a lot of functions.  To reduce this we should add `--pass-arg=asyncify-removelist@name1,name2,name3` with things like sqlite3_malloc, sqlite3_str, sqlite3_bind*, etc.
%.async.wasm: %.wasm
	wasm-opt $(WOFLAGS) -o dist/$@ dist/$<
	gzip -f -k dist/$@

clean:
	rm dist/*.wasm dist/*.wat dist/*.wasm.gz
