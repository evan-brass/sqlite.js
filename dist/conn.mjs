import { OutOfMemError, Trait } from './util.mjs';
import { default as sqlite_initialized, sqlite3, memdv, read_str, handle_error } from './sqlite.mjs';
import {
	SQLITE_ROW, SQLITE_DONE,
	SQLITE_OPEN_URI, SQLITE_OPEN_CREATE, SQLITE_OPEN_EXRESCODE, SQLITE_OPEN_READWRITE,

} from "./sqlite_def.mjs";
import { Bindable, value_to_js } from './value.mjs';
import { dyn_s, free_s, stat_s } from './strings.mjs';

export const SqlCommand = new Trait("This trait marks special commands which can be used inside template literals tagged with the Conn.sql tag.");

export class OpenParams {
	pathname = stat_s(":memory:");
	flags = SQLITE_OPEN_URI | SQLITE_OPEN_CREATE | SQLITE_OPEN_EXRESCODE | SQLITE_OPEN_READWRITE
	vfs = stat_s("");
	constructor() { Object.assign(this, ...arguments); }
	async [SqlCommand](conn) {
		await conn.open(this);
	}
}

class Bindings {
	inner = [];
	strings_from_args(strings, args) {
		let ret = strings[0];
		for (let i = 0; i < args.length; ++i) {
			const arg = args[i];
			this.inner.push(arg);
			if ((typeof arg != 'object' && typeof arg != 'function') || arg === null || arg instanceof ArrayBuffer || ArrayBuffer.isView(arg)) {
				ret += '?';
			}
			ret += strings[i + 1];
		}
		return ret;
	}
	next_anon() {
		for (let i = 0; i < this.inner.length; ++i) {
			const arg = this.inner[i];
			if ((typeof arg != 'object' && typeof arg != 'function') || arg instanceof ArrayBuffer || ArrayBuffer.isView(arg)) {
				return this.inner.splice(i, 1)[0];
			}
		}
	}
	next_named() {
		for (let i = 0; i < this.inner.length; ++i) {
			const arg = this.inner[i];
			if (typeof arg == 'object' && !(arg instanceof ArrayBuffer) && !ArrayBuffer.isView(arg) && !(arg instanceof SqlCommand)) {
				return this.inner.splice(i, 1)[0];
			}
		}
	}
	command() {
		if (this.inner[0] instanceof SqlCommand) {
			return this.inner.shift();
		}
	}
	bind(stmt) {
		const num_params = sqlite3.sqlite3_bind_parameter_count(stmt);
		let named;
		for (let i = 1; i <= num_params; ++i) {
			const name_ptr = sqlite3.sqlite3_bind_parameter_name(stmt, i);
			let arg;
			if (name_ptr == 0) {
				arg = this.next_anon();
			} else {
				const name = read_str(name_ptr);
				const key = name.slice(1);
				named ??= this.next_named();
				arg = named[key]
			}
			Bindable.bind(stmt, i, arg);
		}
	}
}

export class Conn {
	ptr = 0;
	// Lifecycle
	async open(params = new OpenParams()) {
		await sqlite_initialized;

		let pathname, conn_ptr;
		let conn = 0;
		let vfs = 0;
		try {
			pathname = dyn_s(params.pathname);
			conn_ptr = sqlite3.malloc(4);
			if (params.vfs) {
				vfs = dyn_s(params.vfs);
				if (!vfs) throw new OutOfMemError();
			}
			if (!pathname || !conn_ptr) throw new OutOfMemError();

			let res = await sqlite3.sqlite3_open_v2(pathname, conn_ptr, params.flags, vfs);
			conn = memdv().getInt32(conn_ptr, true);
			handle_error(res, conn);
		} catch(e) {
			sqlite3.sqlite3_close_v2(conn);
			throw e;
		} finally {
			free_s(pathname);
			free_s(vfs);
			sqlite3.free(conn_ptr);
		}

		if (this.ptr) {
			this.close();
		}
		this.ptr = conn;
	}
	async *backup(dest, { src_db = stat_s('main'), dest_db = stat_s('main'), pages_per = 5 } = {}) {
		let dconn;
		if (dest instanceof OpenParams) {
			dconn = new Conn();
			await dconn.open(dest);
		} else if (dest instanceof Conn) {
			dconn = dest;
		} else { throw new Error(); }

		const src_name = dyn_s(src_db);
		const dest_name = dyn_s(dest_db);
		let backup;
		try {
			if (!src_name || !dest_name) throw new OutOfMemError();
			backup = await sqlite3.sqlite3_backup_init(dconn.ptr, dest_name, this.ptr, src_name); // Does this need to be awaited?
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
			free_s(src_name);
			free_s(dest_name);
			if (dconn != dest) dconn.close();
		}
	}
	close() {
		const old = this.ptr;
		this.ptr = 0;
		sqlite3.sqlite3_close_v2(old);
	}
	// Meta
	filename(db_name = stat_s('main')) {
		if (!this.ptr) return;
		const name = dyn_s(db_name);
		try {
			if (!name) throw new OutOfMemError();
			const filename_ptr = sqlite3.sqlite3_db_filename(this.ptr, name);
			return read_str(filename_ptr) || ':memory:';
		} finally {
			free_s(name);
		}
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
	async *stmts(sql) {
		if (!sql) return; // Fast path empty sql (useful if you send a single command using Conn.sql)
		
		await sqlite_initialized;

		sql = dyn_s(sql);
		const sql_end_ptr = sqlite3.malloc(4);
		const stmt_ptr = sqlite3.malloc(4);
		try {
			if (!sql || !sql_end_ptr || !stmt_ptr) throw new OutOfMemError();
			memdv().setInt32(sql_end_ptr, sql, true);
			const sql_end = sql.ptr + sql.len;
	
			while (1) {
				const sql_ptr = memdv().getInt32(sql_end_ptr, true);
				const remainder = sql_end - sql_ptr;
				if (remainder <= 1) break;
	
				let stmt;
				try {
					// If we don't have any connection open, then connect.
					if (!this.ptr) await this.open();

					const res = await sqlite3.sqlite3_prepare_v2(this.ptr, sql_ptr, remainder, stmt_ptr, sql_end_ptr);
					stmt = memdv().getInt32(stmt_ptr, true);
					handle_error(res, this.ptr);
	
					if (stmt) yield stmt;
				} finally {
					sqlite3.sqlite3_finalize(stmt);
				}
			}
		} finally {
			free_s(sql);
			sqlite3.free(sql_end_ptr);
			sqlite3.free(stmt_ptr);
		}
	}
	async *sql(strings, ...args) {
		const bindings = new Bindings();
		const concat = bindings.strings_from_args(strings, args);

		let command = bindings.command();
		if (command instanceof SqlCommand) {
			await command[SqlCommand](this);
		}
		for await (const stmt of this.stmts(concat)) {
			bindings.bind(stmt);
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
						const column_name = read_str(sqlite3.sqlite3_column_name(stmt, i));
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

			let command = bindings.command();
			if (command instanceof SqlCommand) {
				await command[SqlCommand](this);
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
