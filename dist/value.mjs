import { alloc_str, handle_error, mem8, read_str, sqlite3 } from "./sqlite.mjs";
import { SQLITE3_TEXT, SQLITE_BLOB, SQLITE_FLOAT, SQLITE_INTEGER, SQLITE_NULL } from "./sqlite_def.mjs";
import { is_safe } from "./util.mjs";

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
}
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
			const ptr = alloc_str(inner);
			res = sqlite3.sqlite3_bind_text(stmt, i, ptr, sqlite3.strlen(ptr), sqlite3.free_ptr());
		}
		else if (inner instanceof ArrayBuffer || ArrayBuffer.isView(inner)) {
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
}
