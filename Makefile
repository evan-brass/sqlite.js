# CC should be clang from wasi-sdk: https://github.com/WebAssembly/wasi-sdk
CC ?= clang

sqlite3.async.wasm: sqlite3.wasm
	wasm-opt -O4 --asyncify -o $@ $^

sqlite3.wasm: c_src/main.c vendor/sqlite3.c include/sqlite_cfg.h vendor/sqlite3.h
	$(CC) -v -target wasm32-unknown-wasi -O3 -Iinclude -Ivendor -D_HAVE_SQLITE_CONFIG_H -o $@ -Wl,--export-dynamic,--export=malloc,--export=free,--export=realloc,--export=strlen vendor/sqlite3.c c_src/main.c
