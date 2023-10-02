import { sqlite3, mem8 } from "./sqlite.mjs";
import { OutOfMemError, is_promise } from "sql.mjs/util.mjs";

const encoder = new TextEncoder();

class Span {
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

// This is a little bit like having a stack frame.
export function borrow_mem(args, func) {	
	// Get the sizes / initial values for the fields
	const sizes = [];
	const inits = []; // The values to set at the memory locations (Uint8Arrays)
	for (const i in args) {
		const arg = args[i];
		if (typeof arg == 'number') {
			sizes[i] = arg;
		}
		if (typeof arg == 'string') {
			const terminated = arg.endsWith('\0') ? arg : arg + '\0';
			const encoded = encoder.encode(terminated);
			inits[i] = encoded;
			sizes[i] = encoded.byteLength;
		}
		if (ArrayBuffer.isView(arg)) {
			inits[i] = new Uint8Array(arg.buffer, arg.byteOffset, arg.byteLength);
			sizes[i] = arg.byteLength;
		}
		if (arg instanceof ArrayBuffer) {
			inits[i] = new Uint8Array(arg);
			sizes[i] = arg.byteLength;
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

	// Allocate the memory
	const alloc = sqlite3.malloc(alloc_size);
	if (alloc === 0) throw new OutOfMemError();

	// Initialize the memory, convert the relative pointers into absolute pointers
	const mapped = [];
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
