import { sqlite3, imports, memdv, mem8, handle_error, alloc_str, read_str } from "./sqlite.mjs";
import {
	SQLITE_INTEGER, SQLITE_FLOAT, SQLITE3_TEXT, SQLITE_BLOB, SQLITE_NULL
} from "./sqlite_def.mjs";

export const funcs = [];

export function create_scalar_func(conn, func, {flags = 0, nArgs = func.length} = {}) {
	const name_ptr = alloc_str(func.name);
	const res = sqlite3.create_scalar_function(
		conn,
		name_ptr,
		nArgs,
		flags,
		funcs.length
	);
	handle_error(res);

	funcs.push(func);
}

export function value2js(value_ptr) {
	const type = sqlite3.sqlite3_value_type(value_ptr);
	if (type == SQLITE_INTEGER) {
		return sqlite3.sqlite3_value_int64(value_ptr);
	}
	else if (type == SQLITE_FLOAT) {
		return sqlite3.sqlite3_value_double(value_ptr);
	}
	else if (type == SQLITE_BLOB) {
		const len = sqlite3.sqlite3_value_bytes(value_ptr);
		return mem8(sqlite3.sqlite3_value_blob(value_ptr), len);
	}
	else if (type == SQLITE_NULL) {
		return null;
	}
	else if (type == SQLITE3_TEXT) {
		const len = sqlite3.sqlite3_value_bytes(value_ptr);
		return read_str(sqlite3.sqlite3_value_text(value_ptr), len);
	}
}

imports['func'] = {
	async xFunc(ctx_ptr, num_args, args_ptr) {
		const i = sqlite3.sqlite3_user_data(ctx_ptr);
		const f = funcs[i];
		const args = [];
		const dv = memdv();
		for (let i = 0; i < num_args; ++i) {
			const value_ptr = dv.getInt32(args_ptr + 4 * i, true);
			args[i] = value2js(value_ptr);
		}

		try {
			// TODO: Make xFunc not always async
			const res = await f(...args);

			debugger;
		} catch (e) {
			// Set the error on the context
		}
	}
};
