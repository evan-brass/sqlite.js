# sql.mjs
It's like sql.js except:
1. Compiled using wasi-sdk instead of emscripten
2. Transformed via wasm-opt's asyncify pass
3. Comes with an Origin-Private-File-System VFS (you still have to load it though.)

## How to build
In order to build you'll need to have wasm-opt installed.  You'll also need to download the wasi-sdk version 20.0 and extract it into the root of this repository.  Then run `make` or `make RELEASE=true`.
