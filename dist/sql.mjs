import { 
	SQLITE_OK,
	SQLITE_CANTOPEN,
	SQLITE_ROW, SQLITE_DONE,
	SQLITE_IOERR, SQLITE_IOERR_SHORT_READ,
	SQLITE_OPEN_CREATE, SQLITE_OPEN_EXRESCODE, SQLITE_OPEN_READWRITE,
	SQLITE_INTEGER, SQLITE_FLOAT, SQLITE3_TEXT, SQLITE_BLOB, SQLITE_NULL
} from "./sqlite_def.mjs";
import spawn_in_worker from "./vm.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const vfs_impls = new Map();
const last_errors = new Map();
const file_impls = new Map();
const file_vfs = new Map();
export class Vfs {
	name = "mem";
	max_pathname = 64;
	async open(filename, flags) { throw new Error("Default VFS only supports in-memory connections."); }
	async delete(filename, sync) { throw new Error("Default VFS only supports in-memory connections."); }
	async access(filename, flags) { throw new Error("Default VFS only supports in-memory connections."); }
	full_pathname(filename) { return filename; }
	randomness(len) { return crypto.getRandomValues(new Uint8Array(len)); }
	async sleep(microseconds) { await new Promise(res => setTimeout(res, microseconds / 1000)); }
	current_time() { return BigInt(Date.now()) + 210866760000000n; }
}
export class VfsFile {
	sector_size = 0;
	flags = 0;
	async close() { throw new Error("Missing close implementation"); }
	async read(buff, offset) { throw new Error("Missing read implementation"); }
	async write(buff, offset) { throw new Error("Missing write implementation"); }
	async truncate(size) { throw new Error("Missing truncate implementation"); }
	async sync(flags) {}
	async size() { throw new Error("Missing size implementation"); }
	async lock(lock_level) { throw new Error("Missing lock implementation"); }
	async unlock(lock_level) { throw new Error("Missing unlock implementation"); }
	async check_reserved_lock() { throw new Error("Missing check_reserved_lock implementation"); }
	file_control(op, arg) { return SQLITE_NOTFOUND; }
	device_characteristics() { return 0; }
}
export const sqlite3 = await spawn_in_worker(fetch(new URL('sqlite3.wasm', import.meta.url)), {
	env: {
		async logging(_, code, msg_ptr) {
			const message = await read_str(msg_ptr);
			console.log(`SQLite(${code}): ${message}`);
			return 0; // Unused, but this is because every import is required to return a numeric value
		},
		async sqlite3_os_init() {
			console.log('sqlite3_os_init');
			await sqlite3.set_logging();
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
			const filename = await read_str(filename_ptr);
			console.log('xOpen', impl, filename, flags);
			try {
				const file = await impl.open(filename, flags);
				file_impls.set(file_out, file);
				file_vfs.set(file_out, impl);
				
				const io_methods = await sqlite3.get_io_methods();
				const flags_out_dv = sqlite3.memory.dv(flags_out, 4);
				(flags_out_dv.setInt32(0, file.flags, true), await flags_out_dv.store());
				const file_out_dv = sqlite3.memory.dv(file_out, 4);
				(file_out_dv.setInt32(0, io_methods, true), await file_out_dv.store());
				
				return SQLITE_OK;
			} catch (e) {
				last_errors.set(vfs, `${e.name}: ${e.message}`);
				console.error(e);
				return SQLITE_IOERR;
			}
		},
		async xDelete(vfs, filename_ptr, sync) {
			const impl = vfs_impls.get(vfs);
			const filename = await read_str(filename_ptr);
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
			const filename = await read_str(filename_ptr);
			console.log('xAccess', impl, filename, flags);
			try {
				const res = await impl.access(filename, flags);
				const result_dv = sqlite3.memory.dv(result_ptr, 4);
				(result_dv.setInt32(0, res ? 1 : 0, true), await result_dv.store());
		
				return SQLITE_OK;
			} catch (e) {
				last_errors.set(vfs, `${e.name}: ${e.message}`);
				console.error(e);
				return SQLITE_IOERR;
			}
		},
		async xFullPathname(vfs, filename_ptr, buff_len, buff_ptr) {
			const impl = vfs_impls.get(vfs);
			const filename = await read_str(filename_ptr);
			console.log('xFullPathname', impl, filename, buff_ptr, buff_len);
			let full = await impl.full_pathname(filename);
			if (!full.endsWith('\0')) full += '\0';
			const encoded = encoder.encode(full);
			if (encoded.byteLength > buff_len) return SQLITE_CANTOPEN;
			await sqlite3.memory.write(buff_ptr, encoded);
			return SQLITE_OK;
		},
		async xRandomness(vfs, buff_len, buff_ptr) {
			const impl = vfs_impls.get(vfs);
			console.log('xRandomness', impl);
			const bytes = await impl.randomness(buff_len);
			await sqlite3.memory.write(buff_ptr, bytes);
			return bytes.byteLength;
		},
		async xSleep(vfs, microseconds) {
			const impl = vfs_impls.get(vfs);
			console.log('xSleep', impl, microseconds);
			const ret = await impl.sleep(microseconds);
			return ret;
		},
		async xGetLastError(vfs, buff_len, buff_ptr) {
			console.log('xGetLastError', buff_len);
			let msg = last_errors.get(vfs) ?? "<No Error>";
			if (!msg.endsWith('\0')) msg += '\0';
			let encoded = encoder.encode();
			if (encoded.byteLength > buff_len) encoded = new Uint8Array(encoded.buffer, encoded.byteOffset, buff_len);
			await sqlite3.memory.write(buff_ptr, encoded);
			return SQLITE_OK;
		},
		async xCurrentTimeInt64(vfs, out_ptr) {
			const impl = vfs_impls.get(vfs);
			console.log('xCurrentTimeInt64', impl);
			const res = impl.current_time();
			const out_dv = sqlite3.memory.dv(out_ptr, 8);
			(out_dv.setBigInt64(0, res, true), await out_dv.store());
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
				const read = await impl.read(offset, buff_len);
				await sqlite3.memory.write(buff_ptr, read);
				if (read.byteLength < buff_len) {
					// Zero out the buffer.
					await sqlite3.memory.fill(buff_ptr + read.byteLength, buff_len - read.byteLength, 0);
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
			const buffer = await sqlite3.memory.read(buff_ptr, buff_len);
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
				await impl.truncate(size);
				return SQLITE_OK;
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
				const size_dv = sqlite3.memory.dv(size_ptr, 8);
				(size_dv.setBigInt64(0, size, true), await size_dv.store());
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
				const vfs = file_vfs.get(file);
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
				const res_dv = sqlite3.memory.dv(res_ptr, 4);
				(res_dv.setInt32(0, res ? 1 : 0, true), await res_dv.store());
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

async function alloc_str(s) {
	if (!s.endsWith('\0')) {
		s += '\0';
	}
	const encoded = encoder.encode(s);
	const ptr = await sqlite3.malloc(encoded.byteLength);
	if (!ptr) return;
	await sqlite3.memory.write(ptr, encoded);
	return ptr;
}
async function read_str(ptr, len) {
	if (!len) len = await sqlite3.memory.strlen(ptr);
	let ret = '';
	if (len > 0) {
		const buff = await sqlite3.memory.read(ptr, len);
		ret = decoder.decode(buff);
	}
	return ret;
}

async function handle_error(code, conn) {
	if (code == SQLITE_OK || code == SQLITE_ROW || code == SQLITE_DONE) return;
	let ptr;
	if (conn) {
		ptr = await sqlite3.sqlite3_errmsg(conn);
	} else {
		ptr = await sqlite3.sqlite3_errstr(code);
	}
	const msg = await read_str(ptr);
	throw new Error(`SQLite Error(${code}): ${msg}`);
}
async function alloc_dv(len) {
	const ptr = await sqlite3.malloc(len);
	if (!ptr) return;
	return sqlite3.memory.dv(ptr, len);
}
export async function register_vfs(vfs_impl, make_default = false) {
	const name_ptr = await alloc_str(vfs_impl.name);
	const vfs_ptr = await sqlite3.allocate_vfs(name_ptr, vfs_impl.max_pathname);
	if (!vfs_ptr) throw new Error("Failed to allocate the VFS");
	vfs_impls.set(vfs_ptr, vfs_impl);

	const res = await sqlite3.sqlite3_vfs_register(vfs_ptr, make_default ? 1 : 0);

	await handle_error(res);
}

export default async function connect(pathname, flags = SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_EXRESCODE) {
	let pathname_ptr, conn_dv;
	let conn;
	try {
		pathname_ptr = await alloc_str(pathname);
		conn_dv = await alloc_dv(4);
		if (!pathname_ptr || !conn_dv) return;
		const res = await sqlite3.sqlite3_open_v2(pathname_ptr, conn_dv.ptr, flags, 0);
		conn = (await conn_dv.load()).getInt32(0, true);
		handle_error(res);
	} catch(e) {
		await sqlite3.sqlite3_close_v2(conn);
		throw e;
	} finally {
		await sqlite3.free(pathname_ptr);
		await sqlite3.free(conn_dv.ptr);
	}

	return async function* sql(strings, ...args) {
		// Concat the strings:
		let concat = strings[0];
		const named_args = [];
		for (let i = 0; i < args.length; ++i) {
			const arg = args[i];
			const str = strings[i + 1];
			if (typeof arg == 'object' && arg !== null && !(arg instanceof ArrayBuffer)) {
				named_args.push(arg);
			}
			if (typeof arg != 'object' && !(arg instanceof Blob || arg instanceof ArrayBuffer /* TODO: More valid object bindings */)) {
				concat += '?';
			}
			concat += str;
		}
		const sql_ptr = await alloc_str(concat);
		const sql_len = await sqlite3.memory.strlen(sql_ptr);
		const sql_end_dv = await alloc_dv(4);
		const stmt_dv = await alloc_dv(4);
		try {
			if (!sql_ptr || !sql_end_dv || !stmt_dv) throw new Error('OOM');
			(sql_end_dv.setInt32(0, sql_ptr, true), await sql_end_dv.store());
			const sql_end = sql_ptr + sql_len;

			while (1) {
				const sql_ptr = (await sql_end_dv.load(), sql_end_dv.getInt32(0, true));
				const remainder = sql_end - sql_ptr;
				if (remainder <= 1) break;

				let stmt;
				try {
					const res = await sqlite3.sqlite3_prepare_v2(conn, sql_ptr, remainder, stmt_dv.ptr, sql_end_dv.ptr);
					stmt = (await stmt_dv.load(), stmt_dv.getInt32(0, true));
					await handle_error(res, conn);

					while (1) {
						if (!stmt) break;
						const res = await sqlite3.sqlite3_step(stmt);
						await handle_error(res, conn);

						if (res == SQLITE_ROW) {
							const data_len = await sqlite3.sqlite3_data_count(stmt);
							const data = [];
							for (let i = 0; i < data_len; ++i) {
								const type = await sqlite3.sqlite3_column_type(stmt, i);
								function is_safe(int) {
									return (BigInt(Number.MIN_SAFE_INTEGER) < int) &&
										(int < BigInt(Number.MAX_SAFE_INTEGER));
								}
								if (type == SQLITE_INTEGER) {
									const int = await sqlite3.sqlite3_column_int64(stmt, i);
									if (is_safe(int)) {
										data[i] = Number(int);
									} else {
										data[i] = int;
									}
								}
								else if (type == SQLITE_FLOAT) {
									data[i] = await sqlite3.sqlite3_column_double(stmt, i);
								}
								else if (type == SQLITE3_TEXT) {
									const len = await sqlite3.sqlite3_column_bytes(stmt, i);
									data[i] = await read_str(await sqlite3.sqlite3_column_text(stmt, i), len);
								}
								else if (type == SQLITE_BLOB) {
									const len = await sqlite3.sqlite3_column_bytes(stmt, i);
									data[i] = await sqlite3.memory.read(await sqlite3.sqlite3_column_blob(stmt, i), len);
								}
								else if (type == SQLITE_NULL) {
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
					await sqlite3.sqlite3_finalize(stmt);
				}
			}
		} finally {
			await sqlite3.free(sql_ptr);
			await sqlite3.free(sql_end_dv?.ptr);
			await sqlite3.free(stmt_dv?.ptr);
		}
	}
}
export async function exec(sql) {
	for await (const row of sql) { console.log('row', row); }
}
