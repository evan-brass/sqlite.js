import { Conn, OpenParams } from './conn.mjs';
import { sqlite3 } from './sqlite.mjs';
import { str_ptr, handle_error } from './strings.mjs';

export class ConnPool {
	#conn_count = 0;
	#open;
	#conns = [];
	#waiters = [];
	options = {
		// Initialized can be a promise which we await before creating any connections.  Use it to register any custom VFSs you want.
		initialized: Promise.resolve(false),
		// Init is function that will be passed every new connection.  Use it to set connection configuration options.
		init: async () => {},
		max_conns: 5, // Create a maximum of 5 connections
		max_delay: 10 * 1000
	};
	constructor(open = new OpenParams(), options) {
		this.#open = open;
		Object.assign(this.options, options);
	}
	async return_conn(conn) {
		if (!conn.autocommit) {
			const res = await sqlite3.sqlite3_exec(conn.ptr, str_ptr('ROLLBACK;'), 0, 0, 0);
			handle_error(res);
		}
		if (this.#waiters.length) {
			(this.#waiters.shift())(conn);
		} else {
			this.#conns.push(conn);
		}
	}
	async get_conn() {
		if (this.#conns.length) {
			return this.#conns.pop();
		} else {
			if (this.#conn_count < this.options.max_conns) {
				return await this.make_conn();
			} else {
				if (this.options.max_delay === 0) {
					return;
				}
				const wait_prom = new Promise(res => this.#waiters.push(res));
				if (this.options.max_delay < 0) {
					return await wait_prom;
				} else {
					const delay_prom = new Promise(res => setTimeout(res, this.options.max_delay));
					return await Promise.race([delay_prom, wait_prom]);
				}
			}
		}
	}
	async make_conn() {
		this.#conn_count += 1;
		await this.options.initialized;
		const ret = new Conn();
		await ret.open(this.#open);

		await this.options.init(ret);

		return ret;
	}
	async borrow(func) {
		const conn = await this.get_conn();
		if (!conn) throw new Error("Couldn't get a connection from the pool in time.");
		try {
			return await func(conn);
		} finally {
			await this.return_conn(conn);
		}
	}
}
