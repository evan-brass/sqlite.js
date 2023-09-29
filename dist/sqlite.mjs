import asyncify from './asyncify.mjs';

/**
 * Asyncify will automatically stub out all the imports, so we don't have to provide all the imports during wasm instantiation.
 * What's nice about this is that it lets us add import implementations later from other modules / extensions.  If you only need
 * the in memory vfs (without date / time / random functionality) then you could technically just not import the vfs / func / blob stuff.
 */
export const imports = {};

export let sqlite3;
const stack_size = 2 ** 15; // This is pretty big.  I think a smaller value would work for release builds, but for debug builds I think this is necessary.
export default asyncify(fetch(new URL('sqlite3.async.wasm', import.meta.url)), imports, { stack_size }).then(exports => {
	sqlite3 = exports;
	sqlite3._start(); // Call the main function

	return sqlite3;
});

export function mem8(offset, length) {
	return new Uint8Array(sqlite3.memory.buffer, offset, length);
}
export function memdv(offset, length) {
	return new DataView(sqlite3.memory.buffer, offset, length);
}
