import { alloc_str, mem8, read_str, sqlite3 } from "./sqlite.mjs";
import { SQLITE3_TEXT, SQLITE_BLOB, SQLITE_FLOAT, SQLITE_INTEGER, SQLITE_NULL } from "./sqlite_def.mjs";

export class Value {
	#ptr;
	#typ;
	#numtyp;
	constructor(ptr) {
		this.#ptr = ptr;
	}
	get natural() {
		if (this.typ == SQLITE_INTEGER) return this.bigint;
		if (this.typ == SQLITE_FLOAT) return this.number;
		if (this.typ == SQLITE_BLOB) return this.blob;
		if (this.typ == SQLITE_NULL) return null;
		if (this.typ == SQLITE3_TEXT) return this.string;
	}
	[Symbol.toPrimitive](hint) {
		if (hint == 'number') {
			if (this.typ == SQLITE_INTEGER) return this.bigint;
			else if (this.typ == SQLITE_FLOAT) return this.number;
			else {
				if (this.numtyp == SQLITE_INTEGER) {
					return this.bigint;
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
		this.#sqlite_typ ??= sqlite3.sqlite3_value_type(this.#ptr);
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
		sqlite3.sqlite3_bind_value(stmt, i, this.#ptr);
	}
}
export class RowValue extends Value {
	#stmt;
	#i;
	#typ;
	constructor(stmt, i) {
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
		sqlite3.sqlite3_bind_value(stmt, i, ptr);
	}
}
export class JsValue extends Value {
	#inner;
	constructor(inner) {
		this.#inner = inner;
	}
	[Symbol.toPrimitive](_hint) {
		return this.#inner;
	}
	bind(stmt, i) {
		let inner = this.#inner;
		let typ = typeof inner;
		if (typ == 'boolean') {
			inner = BigInt(inner);
			typ = typeof inner;
		}
		if (inner === undefined || inner === null) {
			sqlite3.sqlite3_bind_null(stmt, i);
		}
		else if (typ == 'bigint') {
			sqlite3.sqlite3_bind_int64(stmt, i, inner);
		}
		else if (typ == 'number') {
			sqlite3.sqlite3_bind_double(stmt, i, inner);
		}
		else if (typ == 'string') {
			const ptr = alloc_str(inner);
			sqlite3.sqlite3_bind_text(stmt, i, ptr, sqlite3.strlen(ptr), sqlite3.free_ptr());
		}
		else if (inner instanceof ArrayBuffer || ArrayBuffer.isView(inner)) {
			const ptr = sqlite3.malloc(inner.byteLength);
			if (!ptr) throw new OutOfMemError();
			const src = new Uint8Array(inner instanceof ArrayBuffer ? inner : inner.buffer, inner.byteOffset ?? 0, inner.byteLength);
			mem8(ptr, src.byteLength).set(src);
			sqlite3.sqlite3_bind_blob(stmt, i, ptr, src.byteLength, sqlite3.free_ptr());
		}
		else {
			throw new Error("Don't know how to bind this");
		}
	}
}
