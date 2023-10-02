import './func.mjs';
import { Pointer, Bindable } from "./value.mjs";
import { Conn } from "./conn.mjs";
import { mem8, memdv, sqlite3 } from "./sqlite.mjs";
import { borrow_mem, handle_error } from "./memory.mjs";

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
		this.create_scalarf(blob_io, {n_args: blob_io.length});
		this.create_scalarf(blob_io, {n_args: blob_io.length + 1});
		this.create_scalarf(blob_io, {n_args: blob_io.length + 2});
		this.create_scalarf(blob_io, {n_args: blob_io.length + 3});
		this.create_scalarf(blob_io, {n_args: blob_io.length + 4});
	}
});

function blob_io(stream_handle, rowid, table_name, column_name, db_name = 'main', offset = 0, length = -1, buffer_size = 2048) {
	if (!(stream_handle instanceof StreamHandle)) throw new Error("First argument must be a StreamHandle.");

	if ([typeof table_name, typeof column_name, typeof db_name].some(typ => typ !== 'string')) {
		throw new Error("Expected table_name, column_name, and db_name to all be string arguments");
	}

	return borrow_mem(
		[4, Number(buffer_size), table_name, column_name, db_name],
		async (handle_ptr, buffer, table_name, column_name, db_name) => {
			// We read the ReadableStream, but *write* the data to the Blob (hence writable access)
			// When we have a WritableStream then we *read* from the blob and write to the stream (readonly access).
			const flags = (stream_handle.stream instanceof ReadableStream) ? 1 : 0;

			let handle;
			try {
				const res = await sqlite3.sqlite3_blob_open(this.db, db_name, table_name, column_name, BigInt(rowid), flags, handle_ptr);
				handle = memdv().getInt32(handle_ptr, true);
				handle_error(res, this.db);

				// Load the length if it's not set:
				if (length < 0) length = sqlite3.sqlite3_blob_bytes(handle) - offset;
				const end = offset + length;
				const init_offset = offset;

				// Do the things
				if (flags /* ReadableStream */) {
					const reader = stream_handle.stream.getReader({mode: 'byob'});
					let transfer = new Uint8Array(buffer.len); // This is the byob buffer that gets transferred back and forth

					while (1) {
						if (offset >= end) { reader.releaseLock(); break; }

						const {value, done} = await reader.read(transfer);
						if (value === undefined) throw new Error('Stream was cancelled'); // TODO: Should this just be a break?
						transfer = value;
						
						mem8(buffer, buffer.len).set(value);
						const res = await sqlite3.sqlite3_blob_write(handle, buffer, value.byteLength, offset);
						try { handle_error(res, this.db); }
						catch (e) {
							// Let the reader know if we cancel:
							await reader.cancel(e);
							throw e;
						}
						
						offset += value.byteLength;
						if (done) break;
					}
				}
				else /* WritableStream */ {
					const writer = stream_handle.stream.getWriter();
					while (offset < end) {
						const chunk_len = Math.min(buffer.len, end - offset);

						// Wait for the writer to be ready and for SQLite to fill the WASM side buffer
						const [_, res] = await Promise.all([writer.ready, sqlite3.sqlite3_blob_read(handle, buffer, chunk_len, offset)]);
						try { handle_error(res, this.db); }
						catch (e) {
							await writer.abort(e);
							throw e; // Rethrow the error
						}

						await writer.write(mem8(buffer, chunk_len));

						offset += chunk_len;
					}
					await writer.close();
				}

				// Return the number of bytes read / written:
				return offset - init_offset;
			} finally {
				// Does this need to be awaited or not?
				await sqlite3.sqlite3_blob_close(handle);
			}
		}
	);
}
