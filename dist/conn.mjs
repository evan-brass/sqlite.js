import { Trait } from './util.mjs';
import { default as sqlite_initialized, sqlite3, memdv } from './sqlite.mjs';
import {
	SQLITE_ROW, SQLITE_DONE,
	SQLITE_OPEN_URI, SQLITE_OPEN_CREATE, SQLITE_OPEN_EXRESCODE, SQLITE_OPEN_READWRITE,
	SQLITE_FCNTL_VFS_POINTER
} from "./sqlite_def.mjs";
import { Bindable, Pointer, value_to_js } from './value.mjs';
import { borrow_mem, str_read, handle_error } from "./memory.mjs";

export const SqlCommand = new Trait("This trait marks special commands which can be used inside template literals tagged with the Conn.sql tag.");

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

export class Conn {
	// inits are functions which are called on each opened (or reopened) conn
	static inits = [];
	ptr = 0;
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
	async *backup(dest, { src_db = 'main', dest_db = 'main', pages_per = 5 } = {}) {
		let dconn;
		if (dest instanceof OpenParams) {
			dconn = new Conn();
			await dconn.open(dest);
		} else if (dest instanceof Conn) {
			dconn = dest;
		} else { throw new Error(); }

		let mem, release_mem;
		borrow_mem([src_db, dest_db], (...t) => {
			mem = t;
			return new Promise(res => release_mem = res);
		});
		[src_db, dest_db] = mem;

		let backup;
		try {
			backup = await sqlite3.sqlite3_backup_init(dconn.ptr, dest_db, this.ptr, src_db); // Does this need to be awaited?
			if (!backup) throw new Error('Backup failed');

			while (1) {
				const res = await sqlite3.sqlite3_backup_step(backup, pages_per);
				handle_error(res, this.ptr);

				if (res == SQLITE_DONE) break;

				const remaining = sqlite3.sqlite3_backup_remaining(backup);
				const count = sqlite3.sqlite3_backup_pagecount(backup);
				yield { remaining, count };
			}
		} finally {
			sqlite3.sqlite3_backup_finish(backup);
			release_mem();
			if (dconn != dest) dconn.close();
		}
	}
	close() {
		const old = this.ptr;
		this.ptr = 0;
		sqlite3.sqlite3_close_v2(old);
	}
	// Meta
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
	// Useful things:
	async *stmts(sql_txt) {
		if (!sql_txt) return; // Fast path empty sql (useful if you send a single command using Conn.sql)
		
		await sqlite_initialized;

		// Borrow the memory we need.  Unfortunately because we're an async generator we have to use a promise to signal when to release that memory, instead of the usual closure system.
		let ptrs, release_mem;
		borrow_mem([4, 4, sql_txt], (...t) => {
			ptrs = t;
			return new Promise(res => release_mem = res);
		});
		const [sql_end_ptr, stmt_ptr, sql] = ptrs;

		// Initialize the sql_end_ptr to be the start of the allocated sql text
		memdv().setInt32(sql_end_ptr, sql, true);
		const sql_end = Number(sql) + sql.len;

		try {
			while (1) {
				const sql_ptr = memdv().getInt32(sql_end_ptr, true);
				const remainder = sql_end - sql_ptr;
				if (remainder <= 1) break;
	
				let stmt;
				try {
					// If we don't have any connection open, then connect.
					// if (!this.ptr) await this.open();

					const res = await sqlite3.sqlite3_prepare_v2(this.ptr, sql_ptr, remainder, stmt_ptr, sql_end_ptr);
					stmt = memdv().getInt32(stmt_ptr, true);
					handle_error(res, this.ptr);
	
					if (stmt) yield stmt;
				} finally {
					sqlite3.sqlite3_finalize(stmt);
				}
			}
		} finally {
			release_mem();
		}
	}
	async *sql(strings, ...args) {
		const {sql, names} = concat_sql(strings);

		// Split the arguments into named and anonymous:
		const anon = [];
		const named = new Map();
		for (let i = 0; i < args.length; ++i) {
			const name = names.get(i);
			if (name) named.set(name, args[i]);
			else anon.push(args[i]);
		}

		// TODO: Prepare all the statements before stepping any of them
		// TODO: Cache prepared statements keyed off of strings (just like sql / names)
		for await (const stmt of this.stmts(sql)) {
			// Bind the parameters:
			const num_params = sqlite3.sqlite3_bind_parameter_count(stmt);
			for (let i = 1; i <= num_params; ++i) {
				const name_ptr = sqlite3.sqlite3_bind_parameter_name(stmt, i);
				const binding = name_ptr ? named.get(str_read(name_ptr)) : anon.shift();
				Bindable.bind(stmt, i, binding);
			}

			let row_class;
			while (1) {
				const res = await sqlite3.sqlite3_step(stmt);
				handle_error(res, this.ptr);

				if (res == SQLITE_DONE) break;
				if (res != SQLITE_ROW) throw new Error("wat?");

				const data_count = sqlite3.sqlite3_data_count(stmt);

				// Create a row class with getters for the column names if we haven't done that yet for this stmt:
				if (!row_class) {
					row_class = class Row extends Array {};
					for (let i = 0; i < data_count; ++i) {
						const column_name = str_read(sqlite3.sqlite3_column_name(stmt, i));
						Object.defineProperty(row_class.prototype, column_name, { get() { return this[i]; } });
					}
				}

				// Fill in the row's values:
				const row = new row_class();
				for (let i = 0; i < data_count; ++i) {
					const value_ptr = sqlite3.sqlite3_column_value(stmt, i);
					row[i] = value_to_js(value_ptr);
				}

				yield row;
			}
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
