import { default as sqlite_initialized, sqlite3, mem8, imports } from "./sqlite.mjs";
import { OutOfMemError, is_promise } from "sql.mjs/util.mjs";
import { SQLITE_OK, SQLITE_ROW, SQLITE_DONE } from "./sqlite_def.mjs";

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

imports['env'] ??= {};
Object.assign(imports['env'], {
	log(_, code, msg_ptr) {
		const msg = str_read(msg_ptr);
		console.log(`SQLite(${code}): ${msg}`);
	}
});

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

export function str_read(ptr, len = sqlite3.strlen(ptr)) {
	let ret = '';
	if (len > 0) {
		ret = decoder.decode(mem8(ptr, len));
	}
	return ret;
}

export class Span {
	#ptr = 0;
	#len = 0;
	constructor(ptr, len) {
		this.#ptr = ptr;
		this.#len = len;
	}
	[Symbol.toPrimitive](_hint) {
		return this.#ptr;
	}
	get len() {
		return this.#len;
	}
}

const leaked = new Map();
const null_span = new Span(0, 0);

// Pre-leak a few useful strings:
leaked.set('\0', null_span);
sqlite_initialized.then(() => {
	leaky('main');
	leaky('js');
	leaky('ROLLBACK;');
	leaky(':memory:');
	leaky('blob_io');
});

export function leaky(v) {
	if (typeof v == 'string' && !v.endsWith('\0')) {
		v += '\0';
	}
	let span = leaked.get(v);
	if (!span) {
		let init;
		if (typeof v == 'string') {
			init = encoder.encode(v);
		}
		else if (v instanceof ArrayBuffer) {
			init = new Uint8Array(v);
		}
		else if (ArrayBuffer.isView(v)) {
			init = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
		}
		else { throw new Error("Can't make a static from this value"); }

		const ptr = sqlite3.malloc(init.byteLength);
		if (!ptr) throw new OutOfMemError();
		mem8(ptr, init.byteLength).set(init);

		span = new Span(ptr, init.byteLength);
		leaked.set(v, span);
	}
	return span;
}

// This is a little bit like having a stack frame.
export function borrow_mem(args, func) {
	// Mapped is what we will pass to func:
	const mapped = [];

	// Get the sizes / initial values for the fields
	const sizes = [];
	const inits = []; // The values to set at the memory locations (Uint8Arrays)
	for (const i in args) {
		const arg = args[i];
		if (arg instanceof Span) {
			// Don't allocate for things that have already been allocated:
			mapped[i] = arg;
		}
		else if (typeof arg == 'number' && arg > 0) {
			sizes[i] = arg;
		}
		else if (typeof arg == 'string') {
			const terminated = arg.endsWith('\0') ? arg : arg + '\0';
			if (leaked.has(terminated)) {
				// Re-use leaked strings:
				mapped[i] = leaked.get(terminated);
			} else {
				const encoded = encoder.encode(terminated);
				inits[i] = encoded;
				sizes[i] = encoded.byteLength;
			}
		}
		else if (arg?.byteLength === 0) {
			mapped[i] = null_span;
		}
		else if (ArrayBuffer.isView(arg)) {
			inits[i] = new Uint8Array(arg.buffer, arg.byteOffset, arg.byteLength);
			sizes[i] = arg.byteLength;
		}
		else if (arg instanceof ArrayBuffer) {
			inits[i] = new Uint8Array(arg);
			sizes[i] = arg.byteLength;
		}
		else {
			throw new Error("borrow_mem doesn't know what to do with this kind of argument.");
		}
	}

	// Compute pointer offsets and the total size of the allocation
	const ptrs = [];
	let alloc_size = 0;
	for (const i in sizes) {
		// Align the allocations to 4 bytes
		while (alloc_size % 4) alloc_size += 1;
		ptrs[i] = alloc_size;
		alloc_size += sizes[i];
	}

	// Bypass allocation if the allocation size is 0 (Everything must already have an entry in mapped)
	if (alloc_size === 0) {
		return func(...mapped);
	}

	// Allocate the memory
	const alloc = sqlite3.malloc(alloc_size);
	if (alloc === 0) throw new OutOfMemError();

	// Initialize the memory, convert the relative pointers into absolute pointers
	for (const i in ptrs) {
		const ptr = alloc + ptrs[i];
		mapped[i] = new Span(ptr, sizes[i]);
		const init = inits[i];
		const dst = mem8(ptr, sizes[i]);
		if (init) { dst.set(init); }
		else { dst.fill(0); }
	}

	let ret;
	try {
		// Call the function and return the result
		ret = func(...mapped);
		return ret;
	} finally {
		// Release the allocation once the function completes
		const release = () => sqlite3.free(alloc);
		if (is_promise(ret)) {
			ret.then(release, release);
		} else {
			release();
		}
	}
}
