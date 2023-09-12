import { sqlite3, mem8 } from "./sqlite.mjs";
import { OutOfMemError } from "./util.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// A string stored in WASM memory
class Str {
	#ptr;
	#inner;
	#len;
	constructor(ptr, inner, len) {
		this.#ptr = ptr;
		this.#inner = inner;
		this.#len = len;
	}
	static alloc(str) {
		// Special case the empty string to be a null ptr:
		if (str == '') return new this(0, str, 0);

		const terminated = str.endsWith('\0') ? str : str + '\0';
		
		const encoded = encoder.encode(terminated);
		const ptr = sqlite3.malloc(encoded.byteLength);
		if (!ptr) return;
		mem8(ptr, encoded.byteLength).set(encoded);
		return new this(ptr, str, encoded.byteLength);
	}
	get len() {
		return this.#len;
	}
	get ptr() {
		return this.#ptr;
	}
	get str() {
		return this.#inner;
	}
	[Symbol.toPrimitive](hint) {
		return (hint == 'number') ? this.ptr : this.str;
	}
	toJSON() {
		return String(this);
	}
}

// Static strings are allocated on first use and never deallocated:
const statics = new Map(); // S -> Str;
statics.set('', Str.alloc(''));

export function stat_s(str) {
	let ret = statics.get(str);
	if (!ret) {
		ret = Str.alloc(str);
		statics.set(str, ret);
	}
	return ret;
}

// Dynamic strings are deallocated when they stop being used:
const registry = new FinalizationRegistry(sqlite3.free);
export function dyn_s(str, { unique = false} = {}) {
	if (str instanceof Str) return str;
	if (!unique) {
		const stat = statics.get(str);
		if (stat) return stat;
	}
	const ret = Str.alloc(str);
	registry.register(ret, ret.ptr, ret);
	return ret;
}

// Free the string (If it was a dynamic string)
export function free_s(str) {
	const was_dyn = registry.unregister(str);
	if (was_dyn) sqlite3.free(str.ptr);
}

// TODO: Don't always free strings in case they are reused over and over?
// TODO: Allocate multiple strings at once?
// TODO: Retreive a string from wasm memory?  If it points to a pointer in statics then return the static?
