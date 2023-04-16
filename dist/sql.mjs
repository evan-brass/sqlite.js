import * as Asyncify from './asyncify.mjs';
import { 
	SQLITE_OK,
	SQLITE_CANTOPEN, SQLITE_NOTFOUND,
	SQLITE_ROW, SQLITE_DONE,
	SQLITE_IOERR, SQLITE_IOERR_SHORT_READ,
	SQLITE_OPEN_CREATE, SQLITE_OPEN_EXRESCODE, SQLITE_OPEN_READWRITE,
	SQLITE_INTEGER, SQLITE_FLOAT, SQLITE3_TEXT, SQLITE_BLOB, SQLITE_NULL, SQLITE_TRANSIENT
} from "./sqlite_def.mjs";

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
const { instance } = await Asyncify.instantiateStreaming(fetch(new URL('sqlite3.async.wasm', import.meta.url)), {
	env: {
		log(_, code, msg_ptr) {
			const msg = read_str(msg_ptr);
			console.log(`SQLite(${code}): ${msg}`);
		}
	},
	vfs: {
		async xOpen(vfs, filename_ptr, file_out, flags, flags_out) {
			const impl = vfs_impls.get(vfs);
			const filename = read_str(filename_ptr);
			// console.log('xOpen', impl, filename, flags);
			try {
				const file = await impl.open(filename, flags);
				file_impls.set(file_out, file);
				file_vfs.set(file_out, impl);
				memdv().setInt32(flags_out, file.flags, true);
				
				return SQLITE_OK;
			} catch (e) {
				last_errors.set(vfs, `${e.name}: ${e.message}`);
				console.error(e);
				return SQLITE_IOERR;
			}
		},
		async xDelete(vfs, filename_ptr, sync) {
			const impl = vfs_impls.get(vfs);
			const filename = read_str(filename_ptr);
			// console.log('xDelete', impl, filename, sync);
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
			const filename = read_str(filename_ptr);
			// console.log('xAccess', impl, filename, flags);
			try {
				const res = await impl.access(filename, flags);
				memdv().setInt32(result_ptr, res ? 1 : 0);
		
				return SQLITE_OK;
			} catch (e) {
				last_errors.set(vfs, `${e.name}: ${e.message}`);
				console.error(e);
				return SQLITE_IOERR;
			}
		},
		xFullPathname(vfs, filename_ptr, buff_len, buff_ptr) {
			const impl = vfs_impls.get(vfs);
			const filename = read_str(filename_ptr);
			let full = impl.full_pathname(filename);
			if (!full.endsWith('\0')) full += '\0';
			encoder.encodeInto(full, mem8(buff_ptr, buff_len));
			return SQLITE_OK;
		},
		xRandomness(_vfs, buff_len, buff_ptr) {
			crypto.getRandomValues(mem8(buff_ptr, buff_len));
			return buff_len;
		},
		async xSleep(_vfs, microseconds) {
			await new Promise(res => setTimeout(res, microseconds / 1000));
		},
		xGetLastError(vfs, buff_len, buff_ptr) {
			// console.log('xGetLastError', buff_len);
			let msg = last_errors.get(vfs) ?? "<No Error>";
			if (!msg.endsWith('\0')) msg += '\0';
			encoder.encodeInto(msg, mem8(buff_ptr, buff_len));
			return SQLITE_OK;
		},
		xCurrentTimeInt64(_vfs, out_ptr) {
			const current_time = BigInt(Date.now()) + 210866760000000n;
			memdv().setBigInt64(out_ptr, current_time, true);
			return SQLITE_OK;
		},
		async xClose(file) {
			const impl = file_impls.get(file);
			// console.log('xClose', impl);
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
			// console.log('xRead', impl, offset, buff_len);
			try {
				const read = await impl.read(offset, buff_len);
				mem8(buff_ptr, read.byteLength).set(read);
				if (read.byteLength < buff_len) {
					// Zero out the buffer.
					mem8(buff_ptr + read.byteLength, buff_len - read.byteLength).fill(0);
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
			// console.log('xWrite', impl, offset, buff_len);
			try {
				await impl.write(mem8(buff_ptr, buff_len).slice(), offset);
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
			// console.log('xTruncate', impl);
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
			// console.log('xSync', impl, flags);
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
			// console.log('xFileSize', impl);
			try {
				const size = await impl.size();
				memdv().setBigInt64(size_ptr, size, true);
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
			// console.log('xLock', impl, lock_level);
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
			// console.log('xUnlock', impl, lock_level);
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
			// console.log('xCheckReservedLock', impl);
			try {
				const res = await impl.check_reserved_lock();
				memdv().setInt32(res_ptr, res ? 1 : 0, true);
				return SQLITE_OK;
			} catch (e) {
				const vfs = file_vfs.get(file);
				last_errors.set(vfs, `${e.name}: ${e.message}`);
				return SQLITE_IOERR;
			}
		},
		async xFileControl(file, op, arg) {
			const impl = file_impls.get(file);
			// console.log('xFileControl', impl, op, arg);
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
			// console.log('xSectorSize', impl);
			return impl.sector_size;
		},
		xDeviceCharacteristics(file) {
			const impl = file_impls.get(file);
			// console.log('xDeviceCharacteristics', impl);
			return impl.device_characteristics();
		}
	}
});
export const sqlite3 = instance.exports;

// Call the main function:
sqlite3._start();

// Asyncify has a 1024 byte rewind stack, but this is insufficient for SQLite.  Allocate a larger stack:
const stack_size = 2 ** 16; // This is the value I've been using for debug builds.  A smaller value would likely work for an optimized build.
const ptr = sqlite3.malloc(stack_size);
memdv().setInt32(Asyncify.DATA_ADDR, ptr, true);
memdv().setInt32(Asyncify.DATA_ADDR + 4, ptr + stack_size, true);

function mem8(offset, length) {
	return new Uint8Array(sqlite3.memory.buffer, offset, length);
}
function memdv(offset, length) {
	return new DataView(sqlite3.memory.buffer, offset, length);
}
function alloc_str(s) {
	if (!s.endsWith('\0')) {
		s += '\0';
	}
	const encoded = encoder.encode(s);
	const ptr = sqlite3.malloc(encoded.byteLength);
	if (!ptr) return;
	mem8(ptr, encoded.byteLength).set(encoded);
	return ptr;
}
function read_str(ptr, len) {
	if (!len) len = sqlite3.strlen(ptr);
	let ret = '';
	if (len > 0) {
		ret = decoder.decode(mem8(ptr, len));
	}
	return ret;
}

function handle_error(code, conn) {
	if (code == SQLITE_OK || code == SQLITE_ROW || code == SQLITE_DONE) return;
	let ptr;
	if (conn) {
		ptr = sqlite3.sqlite3_errmsg(conn);
	} else {
		ptr = sqlite3.sqlite3_errstr(code);
	}
	const msg = read_str(ptr);
	throw new Error(`SQLite Error(${code}): ${msg}`);
}
export function register_vfs(vfs_impl, make_default = false) {
	const name_ptr = alloc_str(vfs_impl.name);
	const vfs_ptr = sqlite3.allocate_vfs(name_ptr, vfs_impl.max_pathname);
	if (!vfs_ptr) throw new Error("Failed to allocate the VFS");
	vfs_impls.set(vfs_ptr, vfs_impl);

	const res = sqlite3.sqlite3_vfs_register(vfs_ptr, make_default ? 1 : 0);

	handle_error(res);
}

export default async function connect(pathname, flags = SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_EXRESCODE) {
	let pathname_ptr, conn_ptr;
	let conn;
	try {
		pathname_ptr = alloc_str(pathname);
		conn_ptr = sqlite3.malloc(4);
		if (!pathname_ptr || !conn_ptr) return;
		const res = await sqlite3.sqlite3_open_v2(pathname_ptr, conn_ptr, flags, 0);
		conn = memdv().getInt32(conn_ptr, true);
		handle_error(res);
	} catch(e) {
		sqlite3.sqlite3_close_v2(conn);
		throw e;
	} finally {
		sqlite3.free(pathname_ptr);
		sqlite3.free(conn_ptr);
	}

	return async function* sql(strings, ...args) {
		// Concat the strings:
		let concat = strings[0];
		const named_args = {};
		const unnamed_args = [];
		for (let i = 0; i < args.length; ++i) {
			const arg = args[i];
			const str = strings[i + 1];
			if (typeof arg == 'object' && arg !== null && !(arg instanceof ArrayBuffer)) {
				Object.assign(named_args, arg);
			} else {
				concat += '?';
				unnamed_args.push(arg);
			}
			concat += str;
		}
		const sql_ptr = alloc_str(concat);
		const sql_len = sqlite3.strlen(sql_ptr);
		const sql_end_ptr = sqlite3.malloc(4);
		const stmt_ptr = sqlite3.malloc(4);
		try {
			if (!sql_ptr || !sql_end_ptr || !stmt_ptr) throw new Error('OOM');
			memdv().setInt32(sql_end_ptr, sql_ptr, true);
			const sql_end = sql_ptr + sql_len;

			while (1) {
				const sql_ptr = memdv().getInt32(sql_end_ptr, true);
				const remainder = sql_end - sql_ptr;
				if (remainder <= 1) break;

				let stmt;
				try {
					const res = await sqlite3.sqlite3_prepare_v2(conn, sql_ptr, remainder, stmt_ptr, sql_end_ptr);
					stmt = memdv().getInt32(stmt_ptr, true);
					handle_error(res, conn);

					const num_params = sqlite3.sqlite3_bind_parameter_count(stmt);
					for (let i = 1; i <= num_params; ++i) {
						const arg_name_ptr = sqlite3.sqlite3_bind_parameter_name(stmt, i);
						let arg;
						if (arg_name_ptr == 0) {
							arg = unnamed_args.shift();
						} else {
							const name = read_str(arg_name_ptr);
							const key = name.substring(1);
							arg = named_args[key];
						}
						let res;
						if (typeof arg == 'boolean') arg = arg ? 1 : 0;
						if (typeof arg == 'bigint') {
							res = sqlite3.sqlite3_bind_int64(stmt, i, arg);
						}
						else if (typeof arg == 'number') {
							res = sqlite3.sqlite3_bind_double(stmt, i, arg);
						}
						else if (typeof arg == 'string') {
							const ptr = alloc_str(arg);
							if (!ptr) throw new Error('OOM');
							res = sqlite3.sqlite3_bind_text(stmt, i, ptr, -1, SQLITE_TRANSIENT);
							sqlite3.free(ptr);
						}
						handle_error(res);
					}
					console.log(num_params);

					while (1) {
						if (!stmt) break;
						const res = await sqlite3.sqlite3_step(stmt);
						handle_error(res, conn);

						if (res == SQLITE_ROW) {
							const data_len = sqlite3.sqlite3_data_count(stmt);
							const data = [];
							for (let i = 0; i < data_len; ++i) {
								const type = sqlite3.sqlite3_column_type(stmt, i);
								function is_safe(int) {
									return (BigInt(Number.MIN_SAFE_INTEGER) < int) &&
										(int < BigInt(Number.MAX_SAFE_INTEGER));
								}
								if (type == SQLITE_INTEGER) {
									const int = sqlite3.sqlite3_column_int64(stmt, i);
									if (is_safe(int)) {
										data[i] = Number(int);
									} else {
										data[i] = int;
									}
								}
								else if (type == SQLITE_FLOAT) {
									data[i] = sqlite3.sqlite3_column_double(stmt, i);
								}
								else if (type == SQLITE3_TEXT) {
									const len = sqlite3.sqlite3_column_bytes(stmt, i);
									data[i] = read_str(sqlite3.sqlite3_column_text(stmt, i), len);
								}
								else if (type == SQLITE_BLOB) {
									const len = sqlite3.sqlite3_column_bytes(stmt, i);
									data[i] = mem8(sqlite3.sqlite3_column_blob(stmt, i), len).slice();
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
					sqlite3.sqlite3_finalize(stmt);
				}
			}
		} finally {
			sqlite3.free(sql_ptr);
			sqlite3.free(sql_end_ptr);
			sqlite3.free(stmt_ptr);
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
