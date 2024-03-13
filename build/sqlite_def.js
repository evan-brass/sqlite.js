import { Lines } from './lines.js';

/**
 * Convert #defines in vendor/sqlite3.h into exported constants in src/dist/sqlite_def.js
 */
export async function build() {
	// I got some weird results when using Deno.readTextFile that I think may be related to it being so large.  That's why we do this line by line.
	const sqlite3_h = await Deno.open('vendor/sqlite3.h');
	const sqlite_def = await Deno.open('src/dist/sqlite_def.js', {write: true, create: true});
	await sqlite_def.truncate();
	await sqlite3_h.readable
		// Decode the file into text
		.pipeThrough(new TextDecoderStream())
		// Split the text into lines
		.pipeThrough(new Lines())
		// Parse each line for defines that match what we want in src/dist/sqlite_def.js
		.pipeThrough(new TransformStream({
			transform(chunk, controller) {
				const res = /^#define ([A-Z][A-Z_0-9]+)( +)\(?(?:\(sqlite3_destructor_type\))?(0x[0-9a-f]+|-?[0-9]+|\"[^"]*\"|[A-Z_]+(?: *\| *\([0-9]+<<[0-9]+\))?)\)?( +\/\*.+)?/i.exec(chunk);
				if (!res) return;
				const { 1: define, 2: spaces, 3: value, 4: comment } = res;
				controller.enqueue(`export const ${define} =${spaces}${value};${comment ?? ''}\n`);
			}
		}))
		// Encode text back into bytes
		.pipeThrough(new TextEncoderStream())
		// Write to sqlite_def.js
		.pipeTo(sqlite_def.writable);
}
