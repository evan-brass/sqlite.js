import { alloc_str, handle_error, mem8, memdv, sqlite3, main_ptr } from './sqlite.mjs';
import { OutOfMemError } from './util.mjs';

export class SqliteBlob {
	conn;
	buffer_ptr;
	buffer_size;
	ptr;
	writable;
	offset;
	len;
	constructor() { Object.assign(this, ...arguments); }
	static async open(conn, table, column, rowid, writable = true, { db_name = 'main', buffer_size = 1024, offset = 0, len} = {}) {
		const buffer_ptr = sqlite3.malloc(buffer_size);
		const blob_ptr = sqlite3.malloc(4);
		const name_ptr = (db_name == 'main') ? main_ptr : alloc_str(db_name);
		const table_ptr = alloc_str(table);
		const column_ptr = alloc_str(column);

		let blob = 0;
		try {
			if (!buffer_ptr || !blob_ptr || !name_ptr || !table_ptr || !column_ptr) throw new OutOfMemError();
			memdv().setInt32(blob_ptr, 0, true); // Not sure if this is neccessary

			const res = await sqlite3.sqlite3_blob_open(conn.ptr, name_ptr, table_ptr, column_ptr, BigInt(rowid), Number(writable), blob_ptr);
			blob = memdv().getInt32(blob_ptr, true);
			handle_error(res, conn.ptr);

			len ??= sqlite3.sqlite3_blob_bytes(blob);

			return new this({conn, buffer_ptr, buffer_size, ptr: blob, writable, offset, len});
		} catch (e) {
			const res = await sqlite3.sqlite3_blob_close(blob); // Does this need to be awaited?
			handle_error(res, conn.ptr);
			throw e;
		} finally {
			sqlite3.free(blob_ptr);
			if (name_ptr != main_ptr) sqlite3.free(name_ptr);
			sqlite3.free(table_ptr);
			sqlite3.free(column_ptr);
		}
	}
	async close() {
		const res = await sqlite3.sqlite3_blob_close(this.ptr);
		this.ptr = 0;
		handle_error(res, this.conn.ptr);
	}
	get buffer() {
		return mem8(this.buffer_ptr, Math.min(this.buffer_size, this.len));
	}
	get done() {
		return this.len == 0;
	}
	async reopen(rowid) {
		const res = await sqlite3.sqlite3_blob_reopen(this.ptr, rowid);
		handle_error(res, this.conn.ptr);
	}
	bytes() {
		return sqlite3.sqlite3_blob_bytes(this.ptr);
	}
	async read(len = Math.min(this.buffer_size, this.len)) {
		const res = await sqlite3.sqlite3_blob_read(this.ptr, this.buffer_ptr, len, this.offset);
		handle_error(res, this.conn.ptr);
		this.offset += len; this.len -= len;
		return mem8(this.buffer_ptr, len);
	}
	async write(len = Math.min(this.buffer_size, this.len)) {
		const res = await sqlite3.sqlite3_blob_write(this.ptr, this.buffer_ptr, len, this.offset);
		handle_error(res, this.conn.ptr);
		this.offset += len; this.len -= len;
	}
	async write_from(readable_stream) {
		const reader = readable_stream.getReader({mod: 'byob'});
		try {
			while (!this.done) {
				const { value, done } = await reader.read(this.buffer);
				if (value) {
					await this.write(value.byteLength);
				}
				if (done) break;
			}
		} finally {
			reader.releaseLock();
		}
	}
	async read_into(writable_stream) {
		const writer = writable_stream.getWriter();
		try {
			while (!this.done) {
				await writer.ready;
				const buff = await this.read(); // Do I need to slice the buff?
				await writer.write(buff);
			}
			await writer.ready;
			await writer.close();
		} finally {
			writer.releaseLock();
		}
	}
}
