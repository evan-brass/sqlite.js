
all: dist/sqlite3.async.wasm dist/sqlite_def.js

dist/sqlite_def.js: vendor/sqlite3.h
	sed -n -E 's/^#define ([A-Z][A-Z0-9_]+)( +)\(?(\(sqlite3_destructor_type\))?((-?0x[0-9A-F]+)|(-?[0-9]+)|("[^"]*")|([A-Z0-9_]+( +\| *\([0-9]+<<[0-9]+\))?))\)?/export const \1 =\2\4;/p' <$^ >$@

c_src/sqlite3.c: vendor/sqlite3.c
	sed 's/__wasi__/__pretend_not_wasi__/g' <$^ >$@

dist/sqlite3.wasm: c_src/main.c c_src/sqlite3.c
	clang -v -O3 \
		-target wasm32-unknown-wasi \
		-Ic_src -Ivendor \
		-D_HAVE_SQLITE_CONFIG_H \
		-Wl,--export-all \
		-o $@ \
		$^

dist/sqlite3.async.wasm: dist/sqlite3.wasm
	wasm-opt -O4 --asyncify \
		-o $@ \
		$^

.PHONY: all
