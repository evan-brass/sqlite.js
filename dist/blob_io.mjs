import './func.mjs';
import { Pointer, Bindable } from "./value.mjs";
import { Conn } from "./conn.mjs";
import { OutOfMemError } from "./util.mjs";
import { stat_s } from "sql.mjs/strings.mjs";
import { handle_error, mem8, memdv, sqlite3 } from "sql.mjs/sqlite.mjs";

// We make ReadableStream / WritableStream Bindable by wrapping them in a StreamHandle which is a subclass of Pointer
class StreamHandle extends Pointer {
	stream;
	constructor(stream) { super(); this.stream = stream; }
}
Object.assign(ReadableStream.prototype, {
	[Bindable](...args) {
		return new StreamHandle(this)[Bindable](...args);
	}
});
Object.assign(WritableStream.prototype, {
	[Bindable](...args) {
		return new StreamHandle(this)[Bindable](...args);
	}
});

// Each connection will need to have incremental blob io re-registered
Object.assign(Conn.prototype, {
	enable_blob_io() {
		this.create_scalarf(blob_io);
		this.create_scalarf(blob_io, {n_args: blob_io.length - 1}); // db_name has a default value of "main"
	}
});

async function blob_io(stream_handle, _rowid, _table_name, _column_name, _db_name) {
	if (!(stream_handle instanceof StreamHandle)) throw new Error("First argument must be a StreamHandle.");

	const handle_ptr_ptr = sqlite3.malloc(4);
	let buffer_ptr = 0, buffer_len = 0;
	try {
		if (!handle_ptr_ptr) throw new OutOfMemError();

		// We read the ReadableStream, but *write* the data to the Blob (hence writable access)
		// When we have a WritableStream then we *read* from the blob and write to the stream.
		const flags = (stream_handle.stream instanceof ReadableStream) ? 1 : 0;
		
		// Argument 0 is the stream_handle
		const rowid_bi = sqlite3.sqlite3_value_int64(this.value_ptr(1));
		const table_name_ptr = sqlite3.sqlite3_value_text(this.value_ptr(2));
		const column_name_ptr = sqlite3.sqlite3_value_text(this.value_ptr(3));
		const db_name_ptr = (this.num_args > 4) ? sqlite3.sqlite3_value_text(this.value_ptr(4)) : stat_s('main');

		let handle_ptr;
		try {
			const res = await sqlite3.sqlite3_blob_open(this.db, db_name_ptr, table_name_ptr, column_name_ptr, rowid_bi, flags, handle_ptr_ptr);
			handle_ptr = memdv().getInt32(handle_ptr_ptr, true);
			handle_error(res, this.db);

			// Do the things:
			const initial_offset = 0;
			let offset = initial_offset;
			if (stream_handle.stream instanceof ReadableStream) {
				const reader = stream_handle.stream.getReader();
				while(1) {
					const {value, done} = await reader.read();
					if (done) break;
					const len = value.byteLength;

					// Alloc / Resize the WASM side buffer to handle the chunk:
					if (buffer_len < len) {
						buffer_len = Math.max(2 * (buffer_len || 1024), len);
						buffer_ptr = sqlite3.realloc(buffer_ptr, buffer_len);
						if (!buffer_ptr) throw new OutOfMemError();
					}

					// Copy the chunk into WASM memory:
					mem8(buffer_ptr, len).set(value);

					// Tell SQLite to write to the blob:
					const res = await sqlite3.sqlite3_blob_write(handle_ptr, buffer_ptr, len, offset);
					try { handle_error(res, this.db); }
					catch (e) {
						// Let the reader know if we cancel:
						await reader.cancel(e);
						throw e;
					}
	
					offset += len;
				}
			}
			else if (stream_handle.stream instanceof WritableStream) {
				const write_buff_len = 2048;
				const writer = stream_handle.stream.getWriter();
				const blob_len = sqlite3.sqlite3_blob_bytes(handle_ptr);
				while (offset < blob_len) {
					const chunk_len = Math.min(write_buff_len, blob_len - offset);
					
					// Allocate / Resize the WASM side buffer
					if (buffer_len < chunk_len) {
						buffer_len = chunk_len;
						buffer_ptr = sqlite3.realloc(buffer_ptr, chunk_len);
						if (!buffer_ptr) throw new OutOfMemError();
					}

					// Wait for the writer to be ready and for SQLite to fill the WASM side buffer
					const [_, res] = await Promise.all([writer.ready, sqlite3.sqlite3_blob_read(handle_ptr, buffer_ptr, chunk_len, offset)]);
					try { handle_error(res, this.db); }
					catch (e) {
						await writer.abort(e);
						throw e; // Rethrow the error
					}

					await writer.write(mem8(buffer_ptr, chunk_len)); // TODO: Does this need a .slice() because of WASM memory detachment?

					offset += chunk_len;
				}
				await writer.close();
			}
			// Return the number of bytes written to the blob:
			return offset - initial_offset;
		} finally {
			// Does this need to be awaited or not?
			await sqlite3.sqlite3_blob_close(handle_ptr);
		}
	} finally {
		sqlite3.free(handle_ptr_ptr);
		sqlite3.free(buffer_ptr);
	}
}
