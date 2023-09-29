import { sqlite3, mem8, imports } from "./sqlite.mjs";
import {
	SQLITE_OK,
	SQLITE_ROW, SQLITE_DONE
} from './sqlite_def.mjs';
import { OutOfMemError } from "sql.mjs/util.mjs";

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

// Reference counted strings in WASM memory.  Can't be modified (const char*) since they are shared.

class Str {
	ptr = 0;
	len = 0;
	aquired = 0;
	released = 0;
	constructor() { Object.assign(this, ...arguments); }
}
const strings = new Map(); // string -> { ptr, len, aquired, released }

export function str_ptr(s) {
	let str = strings.get(s);
	if (!str) {
		if (s == '') {
			str = new Str();
		} else {
			const terminated = s.endsWith('\0') ? s : s + '\0';
			const encoded = encoder.encode(terminated);
			const ptr = sqlite3.malloc(encoded.byteLength);
			if (!ptr) throw new OutOfMemError();
			mem8(ptr, encoded.byteLength).set(encoded);
			str = new Str({ ptr, len: encoded.byteLength });
		}
		strings.set(s, str);
	}
	str.aquired += 1;
	return str.ptr;
}
export function str_len(s) {
	const str = strings.get(s);
	if (!str) throw new Error("You have to call str_ptr on a string before calling str_len on it.");
	return str.len;
}
// str_free 
export function str_free(s) {
	const str = strings.get(s);
	if (!str) return;
	str.released += 1;
	if (str.aquired == str.released) {
		// Deallocate the strings:
		sqlite3.free(str.ptr);
		strings.delete(s);
	}
}
export function str_read(ptr, len = sqlite3.strlen(ptr)) {
	let ret = '';
	if (len > 0) {
		ret = decoder.decode(mem8(ptr, len));
	}
	return ret;
}
export function str_free_ptr() {
	return sqlite3.str_free_ptr();
}

export function handle_error(code, conn) {
	if (code == SQLITE_OK || code == SQLITE_ROW || code == SQLITE_DONE) return;
	let ptr;
	if (conn) {
		ptr = sqlite3.sqlite3_errmsg(conn);
	} else {
		ptr = sqlite3.sqlite3_errstr(code);
	}
	const msg = str_read(ptr);
	throw new Error(`SQLite Error(${code}): ${msg}`);
}

imports['env'] ??= {};
Object.assign(imports['env'], {
	log(_, code, msg_ptr) {
		const msg = str_read(msg_ptr);
		console.log(`SQLite(${code}): ${msg}`);
	}
});

imports['str'] ??= {};
Object.assign(imports['str'], {
	free(ptr) {
		console.log('str.free', ptr);
		// Alternative: Read through the strings map and find the str with the same ptr?
		const s = str_read(ptr);
		str_free(s);
	}
});
