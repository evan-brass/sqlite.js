# You'll need sed, wasi-sdk (in /opt/wasi-sdk), and binaryen (in /opt/binaryen)
all: src/dist/sqlite3.async.wasm src/dist/sqlite_def.js src/dist/.compilers

src/dist/.compilers:
	/opt/wasi-sdk/bin/wasm32-wasi-clang -v &> $@
	/opt/binaryen/bin/wasm-opt --version >> $@

src/dist/sqlite_def.js: vendor/sqlite3.h
	sed -n -E 's/^#define ([A-Z][A-Z0-9_]+)( +)\(?(\(sqlite3_destructor_type\))?((-?0x[0-9A-F]+)|(-?[0-9]+)|("[^"]*")|([A-Z0-9_]+( +\| *\([0-9]+<<[0-9]+\))?))\)?/export const \1 =\2\4;/p' <$^ >$@

c_src/sqlite3.c: vendor/sqlite3.c
	sed 's/__wasi__/__pretend_not_wasi__/g' <$^ >$@

src/dist/sqlite3.wasm: c_src/main.c c_src/sqlite3.c
	/opt/wasi-sdk/bin/wasm32-wasi-clang -v -O3 \
		-Ic_src -Ivendor \
		-D_HAVE_SQLITE_CONFIG_H \
		-Wl,--export-dynamic,--export=malloc,--export=free,--export=realloc,--export=strlen \
		-o $@ \
		$^

src/dist/sqlite3.async.wasm: src/dist/sqlite3.wasm
	/opt/binaryen/bin/wasm-opt -O4 --asyncify \
		-o $@ \
		$^

.PHONY: all
