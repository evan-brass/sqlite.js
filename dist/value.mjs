import { encoder, handle_error, mem8, read_str, sqlite3 } from "./sqlite.mjs";
import { SQLITE3_TEXT, SQLITE_BLOB, SQLITE_FLOAT, SQLITE_INTEGER, SQLITE_NULL, SQLITE_STATIC, SQLITE_TRANSIENT } from "./sqlite_def.mjs";
import { OutOfMemError, Trait, is_safe } from "./util.mjs";
import { Str } from './strings.mjs';

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
			sqlite3.sqlite3_bind_int64(stmt, i, this);
		} else {
			sqlite3.sqlite3_bind_double(stmt, i, this);
		}
	},
	[Resultable](ctx) {
		if (Number.isInteger(this)) {
			sqlite3.sqlite3_result_int64(ctx, this);
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

export class Value {
	#ptr;
	#typ;
	#numtyp;
	constructor(ptr) {
		this.#ptr = ptr;
	}
	get natural() {
		if (this.typ == SQLITE_INTEGER) {
			const ret = this.bigint;
			if (is_safe(ret)) return Number(ret);
			return ret;
		}
		if (this.typ == SQLITE_FLOAT) return this.number;
		if (this.typ == SQLITE_BLOB) return this.blob;
		if (this.typ == SQLITE_NULL) return null;
		if (this.typ == SQLITE3_TEXT) return this.string;
	}
	toJSON() {
		return this.natural;
	}
	[Symbol.toPrimitive](hint) {
		if (hint == 'number') {
			if (this.typ == SQLITE_INTEGER) return this.bigint;
			else if (this.typ == SQLITE_FLOAT) return this.number;
			else {
				if (this.numtyp == SQLITE_INTEGER) {
					const ret = this.bigint;
					if (is_safe(ret)) return Number(ret);
					return ret;
				} else {
					return this.number;
				}
			}
		}
		else if (hint == 'string') {
			return this.string;
		}
		return this.natural;
	}

	get typ() {
		this.#typ ??= sqlite3.sqlite3_value_type(this.#ptr);
		return this.#typ;
	}
	get numtyp() {
		this.#numtyp ??= sqlite3.sqlite3_value_numeric_type(this.#ptr);
		return this.#numtyp;
	}
	get bigint() {
		return sqlite3.sqlite3_value_int64(this.#ptr);
	}
	get number() {
		return sqlite3.sqlite3_value_double(this.#ptr);
	}
	get string() {
		const len = sqlite3.sqlite3_value_bytes(this.#ptr);
		const ptr = sqlite3.sqlite3_value_text(this.#ptr);
		return read_str(ptr, len);
	}
	get blob() {
		const len = sqlite3.sqlite3_value_bytes(this.#ptr);
		const ptr = sqlite3.sqlite3_value_blob(this.#ptr);
		return mem8(ptr, len);
	}
	bind(stmt, i) {
		const res = sqlite3.sqlite3_bind_value(stmt, i, this.#ptr);
		handle_error(res, sqlite3.sqlite3_db_handle(stmt));
	}
	result(ctx) {
		sqlite3.sqlite3_result_value(ctx, this.#ptr);
	}
}
// TODO: Add support for detaching row values ones we move to a new row
export class RowValue extends Value {
	#stmt;
	#i;
	#typ;
	constructor(stmt, i) {
		super();
		this.#stmt = stmt;
		this.#i = i;
	}
	get typ() {
		this.#typ ??= sqlite3.sqlite3_column_type(this.#stmt, this.#i);
		return this.#typ;
	}
	get numtyp() {
		return SQLITE_FLOAT; // Why is there no sqlite3_column_numeric_type()?
	}
	get bigint() {
		return sqlite3.sqlite3_column_int64(this.#stmt, this.#i);
	}
	get number() {
		return sqlite3.sqlite3_column_double(this.#stmt, this.#i);
	}
	get string() {
		const len = sqlite3.sqlite3_column_bytes(this.#stmt, this.#i);
		const ptr = sqlite3.sqlite3_column_text(this.#stmt, this.#i);
		return read_str(ptr, len);
	}
	get blob() {
		const len = sqlite3.sqlite3_column_bytes(this.#stmt, this.#i);
		const ptr = sqlite3.sqlite3_column_blob(this.#stmt, this.#i);
		return mem8(ptr, len);
	}
	bind(stmt, i) {
		const ptr = sqlite3.sqlite3_column_value(this.#stmt, this.#i);
		const res = sqlite3.sqlite3_bind_value(stmt, i, ptr);
		handle_error(res, sqlite3.sqlite3_db_handle(stmt));
	}
	result(ctx) {
		const ptr = sqlite3.sqlite3_column_value(this.#stmt, this.#i);
		sqlite3.sqlite3_result_value(ctx, ptr);
	}
}
export class JsValue extends Value {
	#inner;
	constructor(inner) {
		super();
		this.#inner = inner;
	}
	get natural() {
		return this.#inner;
	}
	[Symbol.toPrimitive](_hint) {
		return this.#inner;
	}
	bind(stmt, i) {
		let inner = this.#inner;
		let typ = typeof inner;
		let res;
		if (typ == 'boolean') {
			inner = BigInt(inner);
			typ = typeof inner;
		}
		if (inner === undefined || inner === null) {
			res = sqlite3.sqlite3_bind_null(stmt, i);
		}
		else if (typ == 'bigint') {
			res = sqlite3.sqlite3_bind_int64(stmt, i, inner);
		}
		else if (typ == 'number') {
			res = sqlite3.sqlite3_bind_double(stmt, i, inner);
		}
		else if (typ == 'string') {
			const str = Str.alloc(inner);
			res = sqlite3.sqlite3_bind_text(stmt, i, str, str.len, sqlite3.free_ptr());
		}
		else if (inner instanceof ArrayBuffer || ArrayBuffer.isView(inner)) {
			// TODO: Check if the buffer is a slice of the WASM memory?  In that case then we shouldn't copy, just pass with SQLITE_TRANSIENT
			const ptr = sqlite3.malloc(inner.byteLength);
			if (!ptr) throw new OutOfMemError();
			const src = new Uint8Array(inner instanceof ArrayBuffer ? inner : inner.buffer, inner.byteOffset ?? 0, inner.byteLength);
			mem8(ptr, src.byteLength).set(src);
			res = sqlite3.sqlite3_bind_blob(stmt, i, ptr, src.byteLength, sqlite3.free_ptr());
		}
		else {
			throw new Error("Don't know how to bind this");
		}
		handle_error(res, sqlite3.sqlite3_db_handle(stmt));
	}
	result(ctx) {
		let inner = this.#inner;
		let typ = typeof inner;
		if (typ == 'boolean') {
			inner = BigInt(inner);
			typ = typeof inner;
		}
		if (inner === undefined || inner === null) {
			sqlite3.sqlite3_result_null(ctx);
		}
		else if (typ == 'bigint') {
			sqlite3.sqlite3_result_int64(ctx, inner);
		}
		else if (typ == 'number') {
			sqlite3.sqlite3_result_double(ctx, inner);
		}
		else if (typ == 'string') {
			const str = Str.alloc(inner);
			sqlite3.sqlite3_result_text(ctx, str, str.len, sqlite3.free_ptr());
		}
		else if (inner instanceof ArrayBuffer || ArrayBuffer.isView(inner)) {
			// TODO: Check if the buffer is a slice of the WASM memory?  In that case then we shouldn't copy, just pass with SQLITE_TRANSIENT
			const ptr = sqlite3.malloc(inner.byteLength);
			if (!ptr) throw new OutOfMemError();
			const src = new Uint8Array(inner instanceof ArrayBuffer ? inner : inner.buffer, inner.byteOffset ?? 0, inner.byteLength);
			mem8(ptr, src.byteLength).set(src);
			sqlite3.sqlite3_result_blob(ctx, ptr, src.byteLength, sqlite3.free_ptr());
		}
		else {
			throw new Error("Don't know how to bind this");
		}
	}
}
export class ZeroBlob extends Value {
	#length = 0;
	constructor(length) {
		super();
		this.#length = length;
	}
	bind(stmt, i) {
		const res = sqlite3.sqlite3_bind_zeroblob(stmt, i, this.#length);
		handle_error(res, sqlite3.sqlite3_db_handle(stmt));
	}
	result(ctx) {
		sqlite3.sqlite3_result_zeroblob(ctx, this.#length);
	}
}
