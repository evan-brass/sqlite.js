import { alloc_str, handle_error, mem8, memdv, sqlite3 } from './sqlite.mjs';
import { OutOfMemError } from './util.mjs';

export async function blob_open(conn, table, column, rowid, {db = 'main', writable = true} = {}) {
	let blob_ptr;
	if (typeof rowid != 'bigint') {
		rowid = BigInt(rowid);
	}

	const blob_ptr_ptr = sqlite3.malloc(4);
	const table_ptr = alloc_str(table);
	const column_ptr = alloc_str(column);
	const db_ptr = alloc_str(db);
	try {
		if (!blob_ptr_ptr || !table_ptr || !column_ptr || !db_ptr) throw new OutOfMemError();

		const res = await sqlite3.sqlite3_blob_open(conn, db_ptr, table_ptr, column_ptr, rowid, Number(writable), blob_ptr_ptr);
		blob_ptr = memdv().getInt32(blob_ptr_ptr, true);
		handle_error(res, conn);

		return blob_ptr;
	} catch (e) {
		sqlite3.sqlite3_blob_close(blob_ptr);
		throw e;
	} finally {
		sqlite3.free(blob_ptr_ptr);
		sqlite3.free(table_ptr);
		sqlite3.free(column_ptr);
		sqlite3.free(db_ptr);
	}
}
async function close(blob_ptr, buffer_ptr, auto_close) {
	sqlite3.free(buffer_ptr);
	if (auto_close) {
		const res = await sqlite3.sqlite3_blob_close(blob_ptr);
		handle_error(res, conn);
	}
}
export function blob_read_source(blob, {buffer_size = 1024, offset = 0, length, auto_close = true} = {}) {
	const buffer_ptr = sqlite3.malloc(buffer_size);
	if (!buffer_ptr) throw new OutOfMemError();

	return {
		type: 'bytes',
		autoAllocateChunkSize: buffer_size,
		async pull(controller) {
			if (typeof length != 'number') {
				length = sqlite3.sqlite3_blob_bytes(blob);
			}
			if (length == 0) {
				controller.close();
				if (auto_close) await close(blob, buffer_ptr, auto_close);
				return;
			}
	
			if (controller.byobRequest) {
				const num_to_read = Math.min(controller.byobRequest.view.byteLength, length, buffer_size);
				const res = await sqlite3.sqlite3_blob_read(blob, buffer_ptr, num_to_read, offset);
				handle_error(res, conn);
				length -= num_to_read;
				offset += num_to_read;
	
				const ret = mem8(buffer_ptr, num_to_read);
				const view = controller.byobRequest.view;
				if (ret.byteLength > view.byteLength) throw new Error('wat?');
				new Uint8Array(view.buffer, view.byteOffset, ret.byteLength).set(ret);
				controller.byobRequest.respond(ret.byteLength);
			} else {
				throw new Error('not implemented yet.');
				controller.enqueue(ret); // Should this buffer be sliced?
			}
		},
		async cancel(_reason) {
			await close(blob, buffer_ptr, auto_close);
		}
	};
}
export function blob_write_source(blob, {buffer_size = 1024, offset = 0, length, auto_close = true} = {}) {
	const buffer_ptr = sqlite3.malloc(buffer_size);
	if (!buffer_ptr) throw new OutOfMemError();
	return {
		async write(chunk, controller) {
			if (typeof length != 'number') {
				length = sqlite3.sqlite3_blob_bytes(blob);
			}

			for (let chunk_remainder = chunk.byteLength; chunk_remainder;) {
				if (length == 0) throw new Error("Can't write past the end of the BlobSource's length");
				const num_to_write = Math.min(chunk_remainder, length, buffer_size);
				const segment = new Uint8Array(chunk.buffer, chunk.byteOffset + chunk.byteLength - chunk_remainder, num_to_write);
				// Put the segment into wasm memory
				mem8(buffer_ptr, num_to_write).set(segment);
	
				const res = await sqlite3.sqlite3_blob_write(blob, buffer_ptr, num_to_write, offset);
				handle_error(res);
				length -= num_to_write;
				offset += num_to_write;
				chunk_remainder -= num_to_write;
			}
		},
		async close(_controller) {
			await close(blob, buffer_ptr, auto_close);
		}
	};
}
