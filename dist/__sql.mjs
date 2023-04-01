import * as Asyncify from 'https://unpkg.com/asyncify-wasm?module';
import {
	SQLITE_OK,
	SQLITE_ROW,
	SQLITE_DONE,
	SQLITE_IOERR,
	SQLITE3_TEXT,
	SQLITE_BLOB,
	SQLITE_FLOAT,
	SQLITE_INTEGER,
	SQLITE_OPEN_CREATE,
	SQLITE_OPEN_EXRESCODE,
	SQLITE_OPEN_READWRITE,
	SQLITE_NOTFOUND,
	SQLITE_IOERR_SHORT_READ
} from './sqlite_def.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder();


const { instance } = await Asyncify.instantiateStreaming(fetch(new URL('sqlite.wasm', import.meta.url)), {
	env: {
		logging(_, code, msg_ptr) {
			const message = cstr_to_js(msg_ptr);
			console.log(`SQLite(${code}): ${message}`);
		},
		async sqlite3_os_init() {
			console.log('sqlite3_os_init');
			await sqlite.set_logging();
			await register_vfs(new Vfs(), true);
			
			return SQLITE_OK;
		},
		async sqlite3_os_end() {
			console.log('sqlite3_os_end');
			return SQLITE_OK;
		}
	},
	vfs: {
		async xOpen(vfs, filename_ptr, file_out, flags, flags_out) {
			const impl = vfs_impls.get(vfs);
			const filename = cstr_to_js(filename_ptr);
			console.log('xOpen', impl, filename, flags);
			try {
				const file = await impl.open(filename, flags);
				file_impls.set(file_out, file);
				file_vfs.set(file_out, impl);
				
				const io_methods = await sqlite.get_io_methods();
				const dv = memdv();
				dv.setInt32(flags_out, file.flags, true);
				dv.setUint32(file_out, io_methods, true);
				
				return SQLITE_OK;
			} catch (e) {
				last_errors.set(vfs, `${e.name}: ${e.message}`);
				console.error(e);
				return SQLITE_IOERR;
			}
		},
		async xDelete(vfs, filename_ptr, sync) {
			const impl = vfs_impls.get(vfs);
			const filename = cstr_to_js(filename_ptr);
			console.log('xDelete', impl, filename, sync);
			try {
				await impl.delete(filename, sync);
		
				return SQLITE_OK;
			} catch (e) {
				last_errors.set(vfs, `${e.name}: ${e.message}`);
				console.error(e);
				return SQLITE_IOERR;
			}
		},
		async xAccess(vfs, filename_ptr, flags, result_ptr) {
			const impl = vfs_impls.get(vfs);
			const filename = cstr_to_js(filename_ptr);
			console.log('xAccess', impl, filename, flags);
			try {
				const res = await impl.access(filename, flags);
				memdv().setInt32(result_ptr, res ? 1 : 0, true);
		
				return SQLITE_OK;
			} catch (e) {
				last_errors.set(vfs, `${e.name}: ${e.message}`);
				console.error(e);
				return SQLITE_IOERR;
			}
		},
		async xFullPathname(vfs, filename_ptr, buff_len, buff_ptr) {
			const impl = vfs_impls.get(vfs);
			const filename = cstr_to_js(filename_ptr);
			console.log('xFullPathname', impl, filename, buff_ptr, buff_len);
			let full = await impl.full_pathname(filename);
			if (!full.endsWith('\0')) full += '\0';

			const buff = mem8(buff_ptr, buff_len);
			encoder.encodeInto(full, buff); // TODO: What if the buffer is too small?
			return SQLITE_OK;
		},
		xRandomness(vfs, buff_len, buff_ptr) {
			const impl = vfs_impls.get(vfs);
			const buffer = mem8(buff_ptr, buff_len);
			console.log('xRandomness', impl);
			return impl.randomness(buffer);
		},
		async xSleep(vfs, microseconds) {
			const impl = vfs_impls.get(vfs);
			// console.log('xSleep', impl, microseconds);
			const ret = await impl.sleep(microseconds);
			return ret;
		},
		xGetLastError(vfs, buff_len, buff_ptr) {
			console.log('xGetLastError', buff_len);
			encoder.encodeInto(last_errors.get(vfs) ?? "<No Error>", mem8(buff_ptr, buff_len));
			return SQLITE_OK;
		},
		xCurrentTimeInt64(vfs, out_ptr) {
			const impl = vfs_impls.get(vfs);
			console.log('xCurrentTimeInt64', impl);
			const res = impl.current_time();
			memdv().setBigInt64(out_ptr, res, true);
		},
		async xClose(file) {
			const impl = file_impls.get(file);
			console.log('xClose', impl);
			try {
				await impl.close();
				return SQLITE_OK;
			} catch (e) {
				const vfs = file_vfs.get(file);
				last_errors.set(vfs, `${e.name}: ${e.message}`);
				console.error(e);
				return SQLITE_IOERR;
			}
		},
		async xRead(file, buff_ptr, buff_len, offset) {
			const impl = file_impls.get(file);
			console.log('xRead', impl, offset, buff_len);
			try {
				const read_buffer = await impl.read(offset, buff_len);
				const buffer = mem8(buff_ptr, buff_len);
				buffer.set(read_buffer);
				if (read_buffer.byteLength < buff_len) {
					// Zero out the buffer.
					buffer.fill(0, read_buffer.byteLength);
					return SQLITE_IOERR_SHORT_READ;
				}
				return SQLITE_OK;
			} catch (e) {
				const vfs = file_vfs.get(file);
				last_errors.set(vfs, `${e.name}: ${e.message}`);
				console.error(e);
				return SQLITE_IOERR;
			}
		},
		async xWrite(file, buff_ptr, buff_len, offset) {
			const impl = file_impls.get(file);
			const buffer = mem8(buff_ptr, buff_len);
			console.log('xWrite', impl, offset, buff_len);
			try {
				await impl.write(buffer, offset);
				return SQLITE_OK;
			} catch (e) {
				const vfs = file_vfs.get(file);
				last_errors.set(vfs, `${e.name}: ${e.message}`);
				console.error(e);
				return SQLITE_IOERR;
			}
		},
		async xTruncate(file, size) {
			const impl = file_impls.get(file);
			console.log('xTruncate', impl);
			try {
				const res = co_await(impl.truncate.bind(impl), size);
				if (res != suspended) { return SQLITE_OK; }
			} catch (e) {
				const vfs = file_vfs.get(file);
				last_errors.set(vfs, `${e.name}: ${e.message}`);
				console.error(e);
				return SQLITE_IOERR;
			}
		},
		async xSync(file, flags) {
			const impl = file_impls.get(file);
			console.log('xSync', impl, flags);
			try {
				await impl.sync(flags);
				return SQLITE_OK;
			} catch (e) {
				const vfs = file_vfs.get(file);
				last_errors.set(vfs, `${e.name}: ${e.message}`);
				console.error(e);
				return SQLITE_IOERR;
			}
		},
		async xFileSize(file, size_ptr) {
			const impl = file_impls.get(file);
			console.log('xFileSize', impl);
			try {
				const size = await impl.size();
				memdv().setBigInt64(size_ptr, BigInt(size), true);
				return SQLITE_OK;
			} catch (e) {
				const vfs = file_vfs.get(file);
				last_errors.set(vfs, `${e.name}: ${e.message}`);
				console.error(e);
				return SQLITE_IOERR;
			}
		},
		async xLock(file, lock_level) {
			const impl = file_impls.get(file);
			console.log('xLock', impl, lock_level);
			try {
				const res = await impl.lock(lock_level);
				if (res === false) { return SQLITE_BUSY; }
				return SQLITE_OK;
			} catch (e) {
				const vfs = file_vfs.get(file);
				last_errors.set(vfs, `${e.name}: ${e.message}`);
				console.error(e);
				return SQLITE_IOERR;
			}
		},
		async xUnlock(file, lock_level) {
			const impl = file_impls.get(file);
			console.log('xUnlock', impl, lock_level);
			try {
				await impl.unlock(lock_level);
				return SQLITE_OK;
			} catch (e) {
				const vfs = memdv().getUint32(file + 4, true);
				last_errors.set(vfs, `${e.name}: ${e.message}`);
				console.error(e);
				return SQLITE_IOERR;
			}
		},
		async xCheckReservedLock(file, res_ptr) {
			const impl = file_impls.get(file);
			console.log('xCheckReservedLock', impl);
			try {
				const res = await impl.check_reserved_lock(); 
				memdv().setInt32(res_ptr, res ? 1 : 0);
				return SQLITE_OK;
			} catch (e) {
				const vfs = file_vfs.get(file);
				last_errors.set(vfs, `${e.name}: ${e.message}`);
				return SQLITE_IOERR;
			}
		},
		async xFileControl(file, op, arg) {
			const impl = file_impls.get(file);
			console.log('xFileControl', impl, op, arg);
			try {
				const res = await impl.file_control(op, arg);
				return res;
			} catch (e) {
				const vfs = file_vfs.get(file);
				last_errors.set(vfs, `${e.name}: ${e.message}`);
				console.error(e);
				return SQLITE_IOERR;
			}
		},
		xSectorSize(file) {
			const impl = file_impls.get(file);
			console.log('xSectorSize', impl);
			return impl.sector_size;
		},
		xDeviceCharacteristics(file) {
			const impl = file_impls.get(file);
			console.log('xDeviceCharacteristics', impl);
			return impl.device_characteristics();
		}
	}
});
export const sqlite = instance.exports;
// Asyncify uses a default stack of 1000 byte stack, but this is too small for our usage:
const stack_size = 4096;
const ptr = await sqlite.malloc(stack_size);
// Set __asyncify_data
new Int32Array(sqlite.memory.buffer, 16 /* DATA_ADDR */).set([ptr, ptr + stack_size]);

export function mem8(ptr, len) {
	return new Uint8Array(instance.exports.memory.buffer, ptr, len);
}
function memdv() {
	return new DataView(instance.exports.memory.buffer);
}
async function js_to_cstr(s) {
	if (!s.endsWith('\0')) {
		s += '\0';
	}
	const encoded = encoder.encode(s);
	const ptr = await sqlite.malloc(encoded.byteLength);
	if (ptr == 0) return;
	mem8(ptr, encoded.byteLength).set(encoded);
	return ptr;
}
export function cstr_to_js(ptr, len = -1) {
	const m8 = mem8();
	if (len < 0) {
		let tail = ptr;
		while (tail < m8.byteLength && m8[tail] != 0) tail += 1;
		len = tail - ptr;
	}
	if (len == 0) {
		return "";
	} else {
		return decoder.decode(mem8(ptr, len));
	}
}

export async function connect(pathname, flags = SQLITE_OPEN_EXRESCODE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE) {
	let conn_ptr, pathname_ptr, conn;
	try {
		conn_ptr = await sqlite.malloc(4);
		pathname_ptr = await js_to_cstr(pathname);
		if (!conn_ptr || !pathname_ptr) throw new Error('OOM');
	
		const res = await sqlite.sqlite3_open_v2(pathname_ptr, conn_ptr, flags, 0);
		conn = memdv().getUint32(conn_ptr, true);

		await handle_error(res, conn);
	} catch(e) {
		await sqlite.sqlite3_close_v2(conn);
		throw e;
	} finally {
		await sqlite.free(conn_ptr);
		await sqlite.free(pathname_ptr);
	}

	return async function* sql(strings, ...args) {
		// Concat the strings:
		let concat = strings[0];
		const named_args = [];
		for (let i = 0; i < args.length; ++i) {
			const arg = args[i];
			const str = strings[i + 1];
			if (typeof arg == 'object' && arg !== null && !(arg instanceof ArrayBuffer)) {
				named_args.push(arg)
			}
			if (typeof arg != 'object' && !(arg instanceof Blob || arg instanceof ArrayBuffer /* TODO: More valid object bindings */)) {
				concat += '?';
			}
			concat += str;
		}
		if (!concat.endsWith('\0')) concat += '\0';
		const sql_encoded = encoder.encode(concat);
		const sql_ptr = await sqlite.malloc(sql_encoded.byteLength);
		const sql_end_ptr = await sqlite.malloc(4);
		const stmt_ptr = await sqlite.malloc(4);
		try {
			if (!sql_ptr || !sql_end_ptr || !stmt_ptr) throw new Error('OOM');
			mem8(sql_ptr).set(sql_encoded);
			memdv().setUint32(sql_end_ptr, sql_ptr, true);
			const sql_end = sql_ptr + sql_encoded.byteLength;

			while (1) {
				const sql_ptr = memdv().getUint32(sql_end_ptr, true);
				const remainder = sql_end - sql_ptr;
				if (remainder <= 1) break;

				let stmt;
				try {
					const res = await sqlite.sqlite3_prepare_v2(conn, sql_ptr, remainder, stmt_ptr, sql_end_ptr);
					stmt = memdv().getUint32(stmt_ptr, true);
					await handle_error(res, conn);

					while (1) {
						if (!stmt) break;
						const res = await sqlite.sqlite3_step(stmt);
						await handle_error(res, conn);
						if (res == SQLITE_ROW) {
							const data_len = await sqlite.sqlite3_data_count(stmt);
							const data = [];
							for (let i = 0; i < data_len; ++i) {
								const type = await sqlite.sqlite3_column_type(stmt, i);
								function is_safe(int) {
									return (BigInt(Number.MIN_SAFE_INTEGER) < int) &&
										(int < BigInt(Number.MAX_SAFE_INTEGER));
								}
								if (type == SQLITE_INTEGER) {
									const int = await sqlite.sqlite3_column_int64(stmt, i);
									if (is_safe(int)) {
										data[i] = Number(int);
									} else {
										data[i] = int;
									}
								}
								else if (type == SQLITE_FLOAT) {
									data[i] = await sqlite.sqlite3_column_double(stmt, i);
								}
								else if (type == SQLITE3_TEXT) {
									const len = await sqlite.sqlite3_column_bytes(stmt, i);
									data[i] = cstr_to_js(await sqlite.sqlite3_column_text(stmt, i), len);
								}
								else if (type == SQLITE_BLOB) {
									const len = await sqlite.sqlite3_column_bytes(stmt, i);
									data[i] = mem8(await sqlite.sqlite3_column_blob(stmt, i), len).slice();
								}
								else if (type == 5) {
									data[i] = null;
								}
								else { throw new Error(); }
							}
							yield data;
						}
						else if (res == SQLITE_DONE) {
							break;
						}
					}
				} finally {
					await sqlite.sqlite3_finalize(stmt);
				}
			}
		} finally {
			await sqlite.free(sql_ptr);
			await sqlite.free(sql_end_ptr);
			await sqlite.free(stmt_ptr);
		}
	}
}

export async function exec(sql) {
	let last_row;
	for await (const row of sql) { console.log('exec', last_row = row); }
	return last_row;
}
