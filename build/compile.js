

export async function build() {
	let res = await new Deno.Command('clang', {
		args: [
			'-v', '-O3',
			'-target', 'wasm32-unknown-wasi', // This target is provided by the wasi-sdk package on alpine
			'-Ic_src', '-Ivendor',
			'-D_HAVE_SQLITE_CONFIG_H',
			'-Wl,--export-dynamic,--export=malloc,--export=free,--export=realloc,--export=strlen', // Export everything dynamic, as well as a few stdlib functions
			'-o', 'src/dist/sqlite3.wasm',
			'c_src/main.c', 'vendor/sqlite3.c'
		],
		stderr: 'inherit',
		stdout: 'inherit',
		stdin: 'null'
	}).output();
	if (!res.success) throw new Error("Failed to compile dist/sqlite3.wasm");

	res = await new Deno.Command('wasm-opt', {
		args: [
			'-O4', '--asyncify',
			'-o', 'src/dist/sqlite3.async.wasm',
			'src/dist/sqlite3.wasm'
		],
		stderr: 'inherit',
		stdout: 'inherit',
		stdin: 'null'
	}).output();
	if (!res.success) throw new Error("Failed to asyncify dist/sqlite3.wasm into dist/sqlite3.async.wasm");
}
