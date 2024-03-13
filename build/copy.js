import { ensureFile, expandGlob } from 'std/fs/mod.ts';
import { relative } from 'std/path/mod.ts';

export async function build() {
	for await (const entry of expandGlob('src/**/*.js')) {
		const dest = 'dist/' + relative('src/', entry.path);
		await ensureFile(dest);
		await Deno.copyFile(entry.path, dest);
	}
	await Promise.all([
		'LICENSE',
		'README.md',
		'package.json'
	].map(p => Deno.copyFile(p, 'dist/' + p)));
}
