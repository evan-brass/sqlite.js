import * as esbuild from 'esbuild';
import glob from 'tiny-glob';
import { copyFile, mkdir } from 'node:fs/promises';

const entryPoints = await glob('src/**/*.js');
await esbuild.build({
	entryPoints,
	minify: true,
	outdir: 'dist'
});

await Promise.all([
	'sqlite3.wasm',
	'sqlite3.async.wasm',
	'README.md',
	'LICENSE',
	'package.json'
].map(src => copyFile(src, 'dist/' + src)));
