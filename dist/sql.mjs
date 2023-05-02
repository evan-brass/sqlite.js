import { OutOfMemError } from './asyncify.mjs';
import { sqlite3, mem8, memdv, read_str, alloc_str, encoder, decoder, handle_error } from './sqlite.mjs';
import {
	SQLITE_ROW, SQLITE_DONE,
	SQLITE_OPEN_CREATE, SQLITE_OPEN_EXRESCODE, SQLITE_OPEN_READWRITE,
	SQLITE_INTEGER, SQLITE_FLOAT, SQLITE3_TEXT, SQLITE_BLOB, SQLITE_NULL
} from "./sqlite_def.mjs";

export async function open(pathname, flags = SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_EXRESCODE) {
	let pathname_ptr, conn_ptr;
	let conn;
	try {
		pathname_ptr = alloc_str(pathname);
		conn_ptr = sqlite3.malloc(4);
		if (!pathname_ptr || !conn_ptr) throw new OutOfMemError();
		const res = await sqlite3.sqlite3_open_v2(pathname_ptr, conn_ptr, flags, 0);
		conn = memdv().getInt32(conn_ptr, true);
		handle_error(res);
	} catch(e) {
		sqlite3.sqlite3_close_v2(conn);
		throw e;
	} finally {
		sqlite3.free(pathname_ptr);
		sqlite3.free(conn_ptr);
	}
	return conn;
}

export async function* stmts(conn, sql) {
	const sql_ptr = alloc_str(sql);
	const sql_len = sqlite3.strlen(sql_ptr);
	const sql_end_ptr = sqlite3.malloc(4);
	const stmt_ptr = sqlite3.malloc(4);
	try {
		if (!sql_ptr || !sql_end_ptr || !stmt_ptr) throw new OutOfMemError();
		memdv().setInt32(sql_end_ptr, sql_ptr, true);
		const sql_end = sql_ptr + sql_len;

		while (1) {
			const sql_ptr = memdv().getInt32(sql_end_ptr, true);
			const remainder = sql_end - sql_ptr;
			if (remainder <= 1) break;

			let stmt;
			try {
				const res = await sqlite3.sqlite3_prepare_v2(conn, sql_ptr, remainder, stmt_ptr, sql_end_ptr);
				stmt = memdv().getInt32(stmt_ptr, true);
				handle_error(res, conn);

				yield stmt;
			} finally {
				sqlite3.sqlite3_finalize(stmt);
			}
		}
	} finally {
		sqlite3.free(sql_ptr);
		sqlite3.free(sql_end_ptr);
		sqlite3.free(stmt_ptr);
	}
}

export function bind_args(stmt, anon_args, named_args) {
	const num_params = sqlite3.sqlite3_bind_parameter_count(stmt);
	let named;
	for (let i = 1; i <= num_params; ++i) {
		const name_ptr = sqlite3.sqlite3_bind_parameter_name(stmt, i);
		let arg;
		if (name_ptr == 0) {
			arg = anon_args.shift();
		} else {
			const name = read_str(name_ptr);
			const key = name.slice(1);
			named ??= named_args.shift();
			arg = named[key]
		}
		const kind = typeof arg;
		if (kind == 'boolean') {
			arg = Number(arg);
		}
		if (arg instanceof ArrayBuffer) {
			arg = new Uint8Array(arg);
		}
		if (arg === null) {
			sqlite3.sqlite3_bind_null(stmt, i);
		}
		else if (kind == 'bigint') {
			sqlite3.sqlite3_bind_int64(stmt, i, arg);
		}
		else if (kind == 'number') {
			sqlite3.sqlite3_bind_double(stmt, i, arg);
		}
		else if (kind == 'string') {
			const encoded = encoder.encode(arg);
			const ptr = sqlite3.malloc(encoded.byteLength);
			if (!ptr) throw new OutOfMemError();
			mem8(ptr, encoded.byteLength).set(encoded);
			sqlite3.sqlite3_bind_text(stmt, i, ptr, encoded.byteLength, sqlite3.free_ptr());
		}
		else if (ArrayBuffer.isView(arg)) {
			const ptr = sqlite3.malloc(arg.byteLength);
			if (!ptr) throw new OutOfMemError();
			mem8(ptr, arg.byteLength).set(new Uint8Array(arg.buffer, arg.byteOffset, arg.byteLength));
			sqlite3.sqlite3_bind_blob(stmt, i, ptr, arg.byteLength, sqlite3.free_ptr());
		}
		else {
			throw new Error('Unknown parameter type.');
		}
	}
}

function is_safe(int) {
	return (BigInt(Number.MIN_SAFE_INTEGER) < int) &&
		(int < BigInt(Number.MAX_SAFE_INTEGER));
}
class Row {
	#column_names = [];
	constructor(stmt) {
		const data_count = sqlite3.sqlite3_data_count(stmt);

		for (let i = 0; i < data_count; ++i) {
			const type = sqlite3.sqlite3_column_type(stmt, i);
			let val;
			if (type == SQLITE_INTEGER) {
				const int = sqlite3.sqlite3_column_int64(stmt, i);
				val = is_safe(int) ? Number(int) : int;
			}
			else if (type == SQLITE_FLOAT) {
				val = sqlite3.sqlite3_column_double(stmt, i);
			}
			else if (type == SQLITE3_TEXT) {
				const len = sqlite3.sqlite3_column_bytes(stmt, i);
				val = read_str(sqlite3.sqlite3_column_text(stmt, i), len);
			}
			else if (type == SQLITE_BLOB) {
				const len = sqlite3.sqlite3_column_bytes(stmt, i);
				val = mem8(sqlite3.sqlite3_column_blob(stmt, i), len).slice();
			}
			else if (type == SQLITE_NULL) {
				val = null;
			}
			const column_name = read_str(sqlite3.sqlite3_column_name(stmt, i));
			this.#column_names[i] = column_name;
			this[column_name] = val;
		}
	}
	get column_names() {
		return this.#column_names;
	}
	*[Symbol.iterator]() {
		for (const key of this.#column_names) {
			yield this[key];
		}
	}
}

export function make_sql(conn) {
	return async function* sql(strings, ...args) {
		// Concat the strings:
		let concat = strings[0];
		const anon_args = [];
		const named_args = [];
		for (let i = 0; i < args.length; ++i) {
			const arg = args[i];
			if (typeof arg == 'object' && arg !== null && !(arg instanceof ArrayBuffer || ArrayBuffer.isView(arg))) {
				// TODO: Add support for Blob?
				named_args.push(arg);
			} else {
				anon_args.push(arg);
				concat += '?';
			}
			concat += strings[i + 1];
		}
		for await (const stmt of stmts(conn, concat)) {
			bind_args(stmt, anon_args, named_args);

			while (1) {
				const res = await sqlite3.sqlite3_step(stmt);
				handle_error(res);

				if (res == SQLITE_DONE) break;
				if (res != SQLITE_ROW) throw new Error("wat?");

				yield new Row(stmt);
			}
		}
	};
}

export async function exec(sql) {
	let last_row;
	for await (const row of sql) { last_row = row; }
	return last_row;
}

export async function rows(sql) {
	const ret = [];
	for await(const row of sql) {
		ret.push(row);
	}
	return ret;
}
