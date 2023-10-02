import { imports, mem8, sqlite3 } from "./sqlite.mjs";
import { SQLITE3_TEXT, SQLITE_FLOAT, SQLITE_INTEGER, SQLITE_NULL, SQLITE_STATIC, SQLITE_TRANSIENT } from "./sqlite_def.mjs";
import { OutOfMemError, Trait, is_safe } from "./util.mjs";
import { leaky, encoder, decoder } from "./memory.mjs";

export const Bindable = new class extends Trait {
	constructor() { super("A value that can be bound to a SQLite Statement."); }
	bind(stmt, i, val) {
		if (val === null || val === undefined) {
			sqlite3.sqlite3_bind_null(stmt, i);
		} else if (val instanceof Bindable) {
			val[Bindable](stmt, i);
		} else {
			throw new Error("Can't bind this kind of value.");
		}
	}
};
export const Resultable = new class extends Trait {
	constructor() { super("A value that can be used as a result for a SQLite registered function."); }
	result(ctx, val) {
		if (val === null || val === undefined) {
			sqlite3.sqlite3_result_null(ctx);
		} else if (val instanceof Resultable) {
			val[Resultable](ctx);
		} else {
			throw new Error("Can't set a value of this type as the result of a SQLite registered function.");
		}
	}
}

Object.assign(BigInt.prototype, {
	[Bindable](stmt, i) {
		sqlite3.sqlite3_bind_int64(stmt, i, this);
	},
	[Resultable](ctx) {
		sqlite3.sqlite3_result_int64(ctx, this);
	}
});
Object.assign(Number.prototype, {
	[Bindable](stmt, i) {
		if (Number.isInteger(this)) {
			sqlite3.sqlite3_bind_int64(stmt, i, BigInt(this));
		} else {
			sqlite3.sqlite3_bind_double(stmt, i, this);
		}
	},
	[Resultable](ctx) {
		if (Number.isInteger(this)) {
			sqlite3.sqlite3_result_int64(ctx, BigInt(this));
		} else {
			sqlite3.sqlite3_result_double(ctx, this);
		}
	}
});
// TODO: Move String implementation. Strings should really receive special handling for static, and to unify them with other strings passed to various SQLite interfaces.
Object.assign(String.prototype, {
	[Bindable](...args) { encoder.encode(this)[Bindable](...args, {is_txt: true}); },
	[Resultable](ctx, {is_error = false} = {}) { encoder.encode(this)[Resultable](ctx, {is_txt: true, is_error}); }
});
Object.assign(Boolean.prototype, {
	[Bindable](...args) { Number(this)[Bindable](...args); },
	[Resultable](...args) { Number(this)[Resultable](...args); }
});
Object.assign(ArrayBuffer.prototype, {
	[Bindable](...args) { new Uint8Array(this)[Bindable](...args); },
	[Resultable](...args) { new Uint8Array(this)[Resultable](...args); }
});
// We won't implement Bindable / Resultable for TypedArrays with BYTES_PER_ELEMENT > 1 because wasm is big endian and we don't know what endianness the native machine has.  We will, however implement Bindable / Resultable for DataView because then we can assume the the user has managed endianess properly.
// ArrayBuffer, DataView, and Strings differ their implementations to Uint8Array.
Object.assign(Uint8Array.prototype, {
	// TODO: Remove is_static and replace it with a Set of static pointers?
	// is_txt, and is_static are flags used by implementations that delegate to this implementation
	[Bindable](stmt, i, { is_txt = false, is_static = false } = {}) {
		// First Check if this TypedArray is already in wasm memory:
		let args;
		if (mem8().buffer === this.buffer) {
			args = [stmt, i, this.byteOffset, this.byteLength, is_static ? SQLITE_STATIC : SQLITE_TRANSIENT];
		} else {
			const ptr = sqlite3.malloc(this.byteLength);
			if (!ptr) throw new OutOfMemError();
			mem8(ptr, this.byteLength).set(this);
			args = [stmt, i, ptr, this.byteLength, sqlite3.free_ptr()];
		}
		if (is_txt) {
			sqlite3.sqlite3_bind_text(...args);
		} else {
			sqlite3.sqlite3_bind_blob(...args);
		}
	},
	[Resultable](ctx, { is_txt = false, is_error = false, is_static = false } = {}) {
		let args;
		if (mem8().buffer === this.buffer) {
			args = [ctx, this.byteOffset, this.byteLength, is_static ? SQLITE_STATIC : SQLITE_TRANSIENT];
		} else {
			const ptr = sqlite3.malloc(this.byteLength);
			if (!ptr) throw new OutOfMemError();
			mem8(ptr, this.byteLength).set(this);
			args = [ctx, ptr, this.byteLength, sqlite3.free_ptr()];
		}
		if (is_txt) {
			if (is_error) {
				const dest = args.pop();
				sqlite3.sqlite3_result_error(...args);
				// sqlite3_result_error doesn't take a destructor function so we may need to destroy it manually:
				if ([SQLITE_STATIC, SQLITE_TRANSIENT].indexOf(dest) == -1) {
					const ptr = args[1];
					sqlite3.free(ptr);
				}
			} else {
				sqlite3.sqlite3_result_text(...args);
			}
		} else {
			sqlite3.sqlite3_result_blob(...args);
		}
	}
});
Object.assign(DataView.prototype, {
	[Bindable](...args) { new Uint8Array(this.buffer, this.byteOffset, this.byteLength)[Bindable](...args); },
	[Resultable](...args) { new Uint8Array(this.buffer, this.byteOffset, this.byteLength)[Resultable](...args); }
});
Object.assign(Error.prototype, {
	// Errors can be a result, but they can't be Bound
	[Resultable](...args) { String(this)[Resultable](...args, {is_error: true}); }
});
// Special case for OutOfMemError When result:
Object.assign(OutOfMemError.prototype, {
	[Resultable](ctx) {
		sqlite3.sqlite3_result_error_nomem(ctx);
	}
});

let pointer_count = 0;
const pointers = new Map();
export class Pointer {
	#ptr = ++pointer_count;
	constructor() { pointers.set(this.#ptr, this); }
	destructor() {}
	get ptr() { return this.#ptr; }
	[Bindable](stmt, i) {
		sqlite3.sqlite3_bind_pointer(stmt, i, this.#ptr, leaky('js'), sqlite3.release_ptr());
	}
	[Resultable](ctx) {
		sqlite3.sqlite3_result_pointer(ctx, this.#ptr, leaky('js'), sqlite3.release_ptr());
	}
}
imports['value'] = {
	release(ptr) {
		const obj = pointers.get(ptr);
		if (pointers.delete(ptr)) {
			obj.destructor();
		}
	}
};

export class ZeroBlob {
	#length;
	constructor(length = 0) {
		this.#length = length;
	}
	get length() { return this.#length; }
	[Bindable](stmt, i) {
		sqlite3.sqlite3_bind_zeroblob(stmt, i, this.#length);
	}
	[Resultable](ctx) {
		sqlite3.sqlite3_result_zeroblob(ctx, this.#length);
	}
}

// Technically, value_ptr should be a protected value, however since JavaScript is single threaded, we should be fine to use value_to_js on unprotected values.  We've compiled SQLite with Threading, because we use asyncify to do coroutines, but as long as our usage of the unprotected value doesn't span an `await` I think we should be fine.
export function value_to_js(value_ptr) {
	// First check if it's a pointer:
	const ptr = sqlite3.sqlite3_value_pointer(value_ptr, leaky('js'));
	if (ptr && pointers.has(ptr)) return pointers.get(ptr);

	const typ = sqlite3.sqlite3_value_type(value_ptr);
	if (typ == SQLITE_FLOAT) {
		return sqlite3.sqlite3_value_double(value_ptr);
	}
	else if (typ == SQLITE_INTEGER) {
		const n = sqlite3.sqlite3_value_int64(value_ptr);
		return is_safe(n) ? Number(n) : n;
	}
	else if (typ == SQLITE_NULL) {
		return null;
	}
	else {
		const length = sqlite3.sqlite3_value_bytes(value_ptr);
		const ptr = (typ == SQLITE3_TEXT) ? sqlite3.sqlite3_value_text(value_ptr) : sqlite3.sqlite3_value_blob(value_ptr);
		const buff = mem8(ptr, length);
		return (typ == SQLITE3_TEXT) ? decoder.decode(buff) : buff;
	}
}
