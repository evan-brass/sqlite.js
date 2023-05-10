import { OutOfMemError } from "./util.mjs";
import { sqlite3, initialized, alloc_str, handle_error, memdv } from "./sqlite.mjs";
import { SQLITE_OPEN_READWRITE, SQLITE_OPEN_CREATE, SQLITE_OPEN_EXRESCODE } from "./sqlite_def.mjs";

export class ConnPool {
	initialized;
	#waiters = [];
	#conns = [];
	#pathname_ptr;
	#conn_ptr;
	#vfs_ptr;
	#flags;
	#max_delay_sec;
	#rollback_ptr;
	#conn_init_func;

	constructor(pathname, {
		pool_size = 3,
		max_delay_sec = 30,
		vfs = false,
		flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_EXRESCODE,
		init_func = false,
		conn_init_func = false
	} = {}) {
		this.initialized = (async () => {
			try {
				// Wait for sqlite to be initialized:
				await initialized;

				this.#pathname_ptr = alloc_str(pathname);
				this.#conn_ptr = sqlite3.malloc(4);
				this.#vfs_ptr = (typeof vfs == 'string') ? alloc_str(vfs) : 0;
				this.#rollback_ptr = alloc_str("ROLLBACK");
				if (!this.#pathname_ptr || !this.#conn_ptr || (vfs && !this.#vfs_ptr) || !this.#rollback_ptr) throw new OutOfMemError();
				this.#flags = flags;
				this.#max_delay_sec = max_delay_sec;
				this.#conn_init_func = conn_init_func;

				if (init_func) await init_func();
	
				// Allocate the conns:
				for (let i = 0; i < pool_size; ++i) {
					await this.allocate_conn();
				}
			} catch (e) {
				this.close();
				throw e;
			}
		})();
	}
	async allocate_conn() {
		let conn;
		try {
			const res = await sqlite3.sqlite3_open_v2(this.#pathname_ptr, this.#conn_ptr, this.#flags, this.#vfs_ptr);
			conn = memdv().getInt32(this.#conn_ptr, true);
			handle_error(res);

			if (this.#conn_init_func) await this.#conn_init_func(conn);

			await this.return_conn(conn);
		} catch (e) {
			sqlite3.sqlite3_close_v2(conn);
		}
	}
	async get_conn() {
		if (!this.#conns.length) {
			let t;
			await new Promise((res, rej) => {
				t = setTimeout(rej, this.#max_delay_sec * 1000);
				this.#waiters.push(res);
			});
			clearTimeout(t);
		}

		return this.#conns.pop();
	}
	async return_conn(conn) {
		// Check if the conn needs to be rolled back:
		const auto_commit = sqlite3.sqlite3_get_autocommit(conn);
		if (!auto_commit) {
			console.warn("Rolling back uncommitted transaction on a connection before returning it to the pool.");
			const res = await sqlite3.sqlite3_exec(conn, this.#rollback_ptr, 0, 0, 0);
			handle_error(res);
		}
		this.#conns.push(conn);
		const waiter = this.#waiters.shift();
		if (waiter) waiter();
	}
	close() {
		sqlite3.free(this.#pathname_ptr);
		sqlite3.free(this.#conn_ptr);
		sqlite3.free(this.#vfs_ptr);
		sqlite3.free(this.#rollback_ptr);
		for (const conn of this.#conns) {
			sqlite3.sqlite3_close_v2(conn);
		}
	}
}
