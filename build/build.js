import { build as step1 } from './sqlite_def.js';

await step1();

// async function sqlite_def() {

// }

// async function compile() {

// }

// async function esbuild() {

// }

// async function copylic() {

// }



// console.log('Compiling dist/sqlite3.wasm');
// await new Deno.Command('clang', {
// 	args: [
// 		'-v', '-O3',
// 		'-target', 'wasm32-unknown-wasi', // This target is provided by the wasi-sdk package on alpine
// 		'-Ic_src', '-Ivendor',
// 		'-D_HAVE_SQLITE_CONFIG_H',
// 		'-Wl,--export-dynamic,--export=malloc,--export=free,--export=realloc,--export=strlen', // Export everything dynamic, as well as a few stdlib functions
// 		'-o', 'dist/sqlite3.wasm',
// 		'c_src/main.c', 'vendor/sqlite3.c'
// 	],
// 	stderr: 'inherit',
// 	stdout: 'inherit',
// 	stdin: 'null'
// }).output();

// console.log('Asyncify-ing dist/sqlite3.wasm -> dist/sqlite3.async.wasm');
// await new Deno.Command('wasm-opt', {
// 	args: [
// 		'-O4', '--asyncify',
// 		'-o', 'dist/sqlite3.async.wasm',
// 		'dist/sqlite3.wasm'
// 	],
// 	stderr: 'inherit',
// 	stdout: 'inherit',
// 	stdin: 'null'
// }).output();

// console.log('Build complete.');
