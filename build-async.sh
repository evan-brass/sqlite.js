wasm-opt --asyncify --pass-arg=asyncify-verbose \
	--pass-arg=asyncify-imports@@async-imports.txt \
	--pass-arg=asyncify-removelist@@async-remove.txt \
	-o dist/sqlite3.async.wasm \
	dist/sqlite3.wasm > asyncify.txt
