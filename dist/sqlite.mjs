import asyncify from './asyncify.mjs';
import {
	SQLITE_OK,
	SQLITE_ROW, SQLITE_DONE
} from './sqlite_def.mjs';
import { stat_s } from './strings.mjs';

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

/**
 * Asyncify will automatically stub out all the imports, so we don't have to provide all the imports during wasm instantiation.
 * What's nice about this is that it lets us add import implementations later from other modules / extensions.  If you only need
 * the in memory vfs (without date / time / random functionality) then you could technically just not import the vfs / func / blob stuff.
 */
export const imports = {
	env: {
		log(_, code, msg_ptr) {
			const msg = read_str(msg_ptr);
			console.log(`SQLite(${code}): ${msg}`);
		}
	}
};

export let sqlite3;
const stack_size = 2 ** 15; // This is pretty big.  I think a smaller value would work for release builds, but for debug builds I think this is necessary.
export default asyncify(fetch(new URL('sqlite3.async.wasm', import.meta.url)), imports, { stack_size }).then(exports => {
	sqlite3 = exports;
	sqlite3._start(); // Call the main function

	stat_s('main');

	return sqlite3;
});

export function handle_error(code, conn) {
	if (code == SQLITE_OK || code == SQLITE_ROW || code == SQLITE_DONE) return;
	let ptr;
	if (conn) {
		ptr = sqlite3.sqlite3_errmsg(conn);
	} else {
		ptr = sqlite3.sqlite3_errstr(code);
	}
	const msg = read_str(ptr);
	throw new Error(`SQLite Error(${code}): ${msg}`);
}

export function mem8(offset, length) {
	return new Uint8Array(sqlite3.memory.buffer, offset, length);
}
export function memdv(offset, length) {
	return new DataView(sqlite3.memory.buffer, offset, length);
}
export function read_str(ptr, len) {
	if (!len) len = sqlite3.strlen(ptr);
	let ret = '';
	if (len > 0) {
		ret = decoder.decode(mem8(ptr, len));
	}
	return ret;
}
