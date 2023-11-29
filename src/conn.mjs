import { default as sqlite_initialized, sqlite3, memdv } from './sqlite.mjs';
import {
	SQLITE_ROW, SQLITE_DONE,
	SQLITE_OPEN_URI, SQLITE_OPEN_CREATE, SQLITE_OPEN_EXRESCODE, SQLITE_OPEN_READWRITE,
	SQLITE_FCNTL_VFS_POINTER,
	SQLITE_PREPARE_PERSISTENT
} from "./sqlite_def.mjs";
import { Bindable, Pointer, value_to_js } from './value.mjs';
import { borrow_mem, str_read, handle_error } from "./memory.mjs";

export class OpenParams extends Pointer {
	pathname = ":memory:";
	flags = SQLITE_OPEN_URI | SQLITE_OPEN_CREATE | SQLITE_OPEN_EXRESCODE | SQLITE_OPEN_READWRITE
	vfs = "";
	constructor() { super(); Object.assign(this, ...arguments); }
}

const concatenated = new WeakMap(); // template literal strings -> {sql, names}
function concat_sql(strings) {
	let ret = concatenated.get(strings);
	if (ret) return ret;
	let sql = strings[0];
	const names = new Map();
	for (let i = 1; i < strings.length; ++i) {
		const res = /^([?:@][\w\d]+)/.exec(strings[i]);
		if (res) { names.set(i - 1, res[1]); }
		else { sql += '?'; }
		sql += strings[i];
	}
	ret = {sql, names};
	concatenated.set(strings, ret);
	return ret;
}

const stmts = new FinalizationRegistry(stmt_ptr => {
	const db = sqlite3.sqlite3_db_handle(stmt_ptr); // Only used to better handle any possible errors
	const res = sqlite3.sqlite3_finalize(stmt_ptr);
	handle_error(res, db);
});
export class Statement {
	#ptr;
	#db;
	#bind_i = 1;
	#row_class;
	static #make_row_class(column_names) {
		Object.freeze(column_names);
		const ret = class Row extends Array {};
		Object.defineProperty(ret.prototype, 'column_names', { value: column_names, writable: false });
		for (let i = 0; i < column_names.length; ++i) {
			if (column_names[i] in ret.prototype) continue;
			Object.defineProperty(ret.prototype, column_names[i], {
				get() { return this[i]; },
				enumerable: true
			});
		}
		return ret;
	}
	constructor(ptr) {
		this.#ptr = ptr;
		this.#db = sqlite3.sqlite3_db_handle(this.#ptr);
		stmts.register(this, this.#ptr, this);
	}
	finalize() {
		const res = sqlite3.sqlite3_finalize(this.#ptr);
		stmts.unregister(this);
		this.#ptr = 0;
		handle_error(res, this.#db);
	}
	clear() {
		this.#bind_i = 1;
		const res = sqlite3.sqlite3_clear_bindings(this.#ptr);
		handle_error(res, this.#db);
		return this;
	}
	bind(value = null, name) {
		borrow_mem([name], name => {
			const i = Number(name) ? sqlite3.sqlite3_bind_parameter_index(this.#ptr, name) : this.#bind_i++;
			Bindable.bind(this.ptr, i, value);
		});
		return this;
	}
	bind_all(anon = [], named = new Map()) {
		const num_params = sqlite3.sqlite3_bind_parameter_count(this.#ptr);
		for (let i = 1; i <= num_params; ++i) {
			const name = str_read(sqlite3.sqlite3_bind_parameter_name(this.#ptr, i));
			Bindable.bind(this.#ptr, i, name ? named.get(name) : anon.shift());
		}
		return this;
	}
	async *[Symbol.asyncIterator]() {
		try {
			while (1) {
				const res = await sqlite3.sqlite3_step(this.#ptr);
				if (res == SQLITE_DONE) break;
				
				handle_error(res, this.#db);
				if (res != SQLITE_ROW) throw new Error("wat?");
				
				const data_count = sqlite3.sqlite3_data_count(this.#ptr);
				this.#row_class ??= Statement.#make_row_class(Array.from({length: data_count}, (_, i) => str_read(sqlite3.sqlite3_column_name(this.#ptr, i))));

				const row = new this.#row_class();
				for (let i = 0; i < data_count; ++i) {
					row[i] = value_to_js(sqlite3.sqlite3_column_value(this.#ptr, i));
				}
				yield row;
			}
		} finally {
			sqlite3.sqlite3_reset(this.#ptr);
		}
	}
	// TODO: Synchronous iterator?
}

export class Conn {
	// inits are functions which are called on each opened (or reopened) conn
	static inits = [];
	ptr = 0;
	#prepared = new WeakMap();

	// Lifecycle
	async open(params = new OpenParams()) {
		await sqlite_initialized;

		let conn;
		await borrow_mem([4, params.pathname, params.vfs], async (conn_ptr, pathname, vfs) => {
			try {
				const res = await sqlite3.sqlite3_open_v2(pathname, conn_ptr, params.flags, vfs);
				conn = memdv().getInt32(conn_ptr, true);
				handle_error(res, conn);
			} catch (e) {
				sqlite3.sqlite3_close_v2(conn);
				throw e;
			}
		});

		if (this.ptr) this.close();
		this.ptr = conn;

		for (const init of this.constructor.inits) {
			init(this);
		}
	}
	close() {
		const old = this.ptr;
		this.ptr = 0;
		sqlite3.sqlite3_close_v2(old);
		this.#prepared = new WeakMap();
	}
	// Meta
	dbnames() {
		if (!this.ptr) return;
		
		const ret = [];
		for (let i = 0; true; ++i) {
			const name_ptr = sqlite3.sqlite3_db_name(this.ptr, i);
			if (!name_ptr) break;
			ret.push(str_read(name_ptr));
		}

		return ret;
	}
	vfsname(db_name = 'main') {
		if (!this.ptr) return;

		return borrow_mem([4, db_name], (vfs_ptr_ptr, db_name) => {
			const res = sqlite3.sqlite3_file_control(this.ptr, db_name, SQLITE_FCNTL_VFS_POINTER, vfs_ptr_ptr);
			handle_error(res, this.ptr);
			const vfs_ptr = memdv().getInt32(vfs_ptr_ptr, true);
			const name_ptr = memdv().getInt32(vfs_ptr + 4 * 4 /* .zName is 5th field, preceded by 3 int and 1 ptr */, true);
			return str_read(name_ptr);
		});
	}
	filename(db_name = 'main') {
		if (!this.ptr) return;
		return borrow_mem([db_name], db_name => {
			const filename_ptr = sqlite3.sqlite3_db_filename(this.ptr, db_name);
			return str_read(filename_ptr) || ':memory:';
		});
	}
	get interrupted() {
		if (!this.ptr) return false;
		return Boolean(sqlite3.sqlite3_is_interrupted(this.ptr));
	}
	get autocommit() {
		if (!this.ptr) return true;
		return Boolean(sqlite3.sqlite3_get_autocommit(this.ptr));
	}
	interrupt() {
		if (this.ptr) {
			sqlite3.sqlite3_interrupt(this.ptr);
		}
	}
	prepare(sql, cache_key = undefined) {
		if (!this.ptr) throw new Error("Can't prepare a SQL statement until the connection has been opened.");

		if (cache_key) {
			const cached = this.#prepared.get(cache_key);
			if (cached) return cached;
		}

		return borrow_mem([4, 4, sql], async (sql_end_ptr, stmt_ptr, sql) => {
			const flags = cache_key ? SQLITE_PREPARE_PERSISTENT : 0;
			memdv().setInt32(sql_end_ptr, sql, true);
			const sql_end = Number(sql) + sql.len;
			
			const stmts = [];
			let remainder = sql.len;
			while (remainder > 1) {
				try {
					const sql_ptr = memdv().getInt32(sql_end_ptr, true);
					const res = await sqlite3.sqlite3_prepare_v3(this.ptr, sql_ptr, remainder, flags, stmt_ptr, sql_end_ptr);
					
					const stmt = memdv().getInt32(stmt_ptr, true);
					if (stmt) stmts.push(new Statement(stmt));

					handle_error(res, this.ptr);

					remainder = sql_end - memdv().getInt32(sql_end_ptr, true);
				} catch(e) {
					stmts.forEach(s => s.finalize());
					throw e;
				}
			}

			if (cache_key) this.#prepared.set(cache_key, stmts);

			return stmts;
		});
	}
	async *sql(strings, ...args) {
		const {sql, names} = concat_sql(strings);
		const stmts = await this.prepare(sql, strings);

		// Split the arguments into named and anonymous:
		const anon = [];
		const named = new Map();
		for (let i = 0; i < args.length; ++i) {
			const name = names.get(i);
			if (name) named.set(name, args[i]);
			else anon.push(args[i]);
		}

		for (const stmt of stmts) {
			stmt.clear().bind_all(anon, named);
			yield* stmt;
		}
	}
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
