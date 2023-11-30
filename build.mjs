import * as esbuild from 'esbuild';
import glob from 'tiny-glob';
import { copyFile } from 'node:fs/promises';

const entryPoints = await glob('src/**/*.js');
await esbuild.build({
	entryPoints,
	minify: true,
	keepNames: true,
	outdir: 'dist'
});

await Promise.all([
	'sqlite3.wasm',
	'sqlite3.async.wasm',
	'README.md',
	'LICENSE',
	'package.json'
].map(src => copyFile(src, 'dist/' + src)));
