// This file is loaded into a WebWorker so that it (and the compiled WebAssembly that it wraps) can be syncronously suspended.



const { instance } = await WebAssembly.instantiateStreaming(fetch(new URL('sqlite.wasm', import.meta.url)), {
	env: { sqlite3_os_init, sqlite3_os_end, logging },
	vfs: { xOpen, xDelete, xAccess, xFullPathname, xRandomness, xSleep, xGetLastError, xCurrentTimeInt64 },
	vfs_io: { xClose, xRead, xWrite, xTruncate, xSync, xFileSize, xLock, xUnlock, xCheckReservedLock, xFileControl, xSectorSize, xDeviceCharacteristics }
});
instance.exports._start();

export function mem8(ptr, len) {
	return new Uint8Array(instance.exports.memory.buffer, ptr, len);
}
function memdv() {
	return new DataView(instance.exports.memory.buffer);
}
function js_to_cstr(s) {
	if (!s.endsWith('\0')) {
		s += '\0';
	}
	const encoded = encoder.encode(s);
	const ptr = instance.exports.malloc(encoded.byteLength);
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

export const sqlite = instance.exports;

const state = { val: null, stack: null, prom: null };
const suspended = Symbol('co_await is suspended');
function co_await(func, ...args) {
	const s = sqlite.asyncify_get_state();
	if (s == 0) {
		const res = func(...args);
		if (typeof res == 'object' && res?.then !== undefined) {
			state.prom = res;
			sqlite.asyncify_start_unwind(state.stack);
			return suspended;
		} else {
			return res;
		}
	} else if (s == 2) {
		sqlite.asyncify_stop_rewind();
		if (state.error) {
			const e = state.error;
			state.error = false;
			throw e;
		} else {
			return state.val;
		}
	} else {
		throw new Error();
	}
	
}
export async function re_enter(stack, func, ...args) {
	while(1) {
		state.stack = stack;
		const res = func(...args);
		const s = sqlite.asyncify_get_state();
		if (s == 1) {
			sqlite.asyncify_stop_unwind();

			// const dv = memdv();
			// const stack_start = stack + 8;
			// const stack_current = dv.getUint32(stack, true);
			// const stack_end = dv.getUint32(stack + 4, true);
			// console.log(`Stack paused: ${stack_end - stack_current} available, ${stack_current - stack_start} used`);

			// TODO: print stack usage.
			try {
				state.val = await state.prom;
				state.error = false;
			} catch (e) {
				state.error = e;
				console.error(e);
			}

			sqlite.asyncify_start_rewind(stack);
		} else if (s == 0) {
			return res;
		} else {
			throw new Error();
		}
	}
}
export function allocate_stack(stack_len = 2040) {
	const ret = sqlite.malloc(stack_len + 8);
	if (!ret) return;
	const dv = memdv();
	const current = ret + 8;
	const end = current + stack_len;
	dv.setUint32(ret, current, true);
	dv.setUint32(ret + 4, end, true);
	return ret;
}

export function handle_error(res, conn = false) {
	// Success Codes:
	if ([SQLITE_OK, SQLITE_ROW, SQLITE_DONE].includes(res)) return;

	const str_ptr = sqlite.sqlite3_errstr(res);
	const str = (str_ptr != SQLITE_MISUSE) ? cstr_to_js(str_ptr) : '<misuse>';
	if (!conn) {
		throw new Error(`SQLite Error(${res}): ${str}`);
	} else {
		let extended = sqlite.sqlite3_extended_errcode(conn);
		if (extended == SQLITE_MISUSE) extended = '<misuse>';
		let offset = sqlite.sqlite3_error_offset(conn);
		if (offset == SQLITE_MISUSE) offset = '<misuse>';
		const msg_ptr = sqlite.sqlite3_errmsg(conn);
		const msg = (msg_ptr !== SQLITE_MISUSE) ? cstr_to_js(msg_ptr) : '<misuse>';
		throw new Error(`SQLite Error({code: ${res}, extended_code: ${extended}, offset: ${offset}}): ${msg} [${str}]`);
	}
}

function def_vfs_err() {
	debugger;
	const e = new Error("Default VFS only supports in-memory connections.");
	console.error(e);
	throw e;
}
export class Vfs {
	name = "mem";
	max_pathname = 64;
	async open(filename, flags) { def_vfs_err(); }
	async delete(filename, sync) { def_vfs_err(); }
	async access(filename, flags) { def_vfs_err(); }
	full_pathname(filename) { return filename; }
	randomness(buff) { crypto.getRandomValues(buff); return buff.byteLength; }
	async sleep(microseconds) { await new Promise(res => setTimeout(res, microseconds / 1000)); }
	current_time() { return BigInt(Date.now()) + 210866760000000n; }
}
const vfs_impls = new Map();
const last_errors = new Map();
const file_impls = new Map();
function xOpen(vfs, filename_ptr, file_out, flags, flags_out) {
	const impl = vfs_impls.get(vfs);
	const filename = cstr_to_js(filename_ptr);
	// console.log('xOpen', impl, filename, flags);
	try {
		const res = co_await(impl.open.bind(impl), filename, flags);
		if (res != suspended) {
			const file = res;
			file_impls.set(file_out, file);

			const dv = memdv();
			
			dv.setInt32(flags_out, file.flags, true);
			dv.setUint32(file_out, sqlite.get_io_methods(), true);
			dv.setUint32(file_out + 4, vfs, true);

			return SQLITE_OK;
		}
	} catch (e) {
		last_errors.set(vfs, `${e.name}: ${e.message}`);
		return SQLITE_IOERR;
	}
}
function xDelete(vfs, filename_ptr, sync) {
	const impl = vfs_impls.get(vfs);
	const filename = cstr_to_js(filename_ptr);
	// console.log('xDelete', impl, filename, sync);
	try {
		const res = co_await(impl.delete.bind(impl), filename, sync);
		if (res == suspended) return;

		return SQLITE_OK;
	} catch (e) {
		last_errors.set(vfs, `${e.name}: ${e.message}`);
		return SQLITE_IOERR;
	}
}
function xAccess(vfs, filename_ptr, flags, result_ptr) {
	const impl = vfs_impls.get(vfs);
	const filename = cstr_to_js(filename_ptr);
	// console.log('xAccess', impl, filename, flags);
	try {
		const res = co_await(impl.access.bind(impl), filename, flags);
		if (res == suspended) return;

		memdv().setInt32(result_ptr, res ? 1 : 0, true);
		return SQLITE_OK;
	} catch (e) {
		last_errors.set(vfs, `${e.name}: ${e.message}`);
		return SQLITE_IOERR;
	}
}
function xFullPathname(vfs, filename_ptr, buff_len, buff_ptr) {
	const impl = vfs_impls.get(vfs);
	const filename = cstr_to_js(filename_ptr);
	// console.log('xFullPathname', impl, filename, buff_ptr, buff_len);
	const full = co_await(impl.full_pathname.bind(impl), filename);
	if (full != suspended) {
		const buff = mem8(buff_ptr, buff_len);
		encoder.encodeInto(full, buff); // TODO: What if the buffer is too small?
		return SQLITE_OK;
	}
}
function xRandomness(vfs, buff_len, buff_ptr) {
	const impl = vfs_impls.get(vfs);
	const buffer = mem8(buff_ptr, buff_len);
	// console.log('xRandomness', impl);
	return impl.randomness(buffer);
}
function xSleep(vfs, microseconds) {
	const impl = vfs_impls.get(vfs);
	// console.log('xSleep', impl, microseconds);
	const ret = co_await(impl.sleep(microseconds));
	if (ret != suspended) return ret;
}
function xGetLastError(vfs, buff_len, buff_ptr) {
	// console.log('xGetLastError');
	encoder.encodeInto(last_errors.get(vfs) ?? "<No Error>", mem8(buff_ptr, buff_len));
	return SQLITE_OK;
}
function xCurrentTimeInt64(vfs, out_ptr) {
	const impl = vfs_impls.get(vfs);
	// console.log('xCurrentTimeInt64', impl);
	const res = impl.current_time();
	memdv().setBigInt64(out_ptr, res, true);
}

export function allocate_vfs(vfs_impl) {
	const zName = js_to_cstr(vfs_impl.name);
	if (!zName) return;
	const ret = instance.exports.allocate_vfs(zName, vfs_impl.max_pathname);
	if (!ret) {
		instance.exports.free(zName);
		return;
	}
	vfs_impls.set(ret, vfs_impl);
	return ret;
}

export function register_vfs(vfs_impl, make_default = false) {
	const ptr = allocate_vfs(vfs_impl);
	if (!ptr) throw new Error("Failed to allocate the VFS");

	const res = sqlite.sqlite3_vfs_register(ptr, make_default ? 1 : 0);

	handle_error(res);
}

export class VfsFile {
	sector_size = 1;
	flags = 0;
	async close() { def_vfs_err(); }
	async read(buff, offset) { def_vfs_err(); }
	async write(buff, offset) { def_vfs_err(); }
	async truncate(size) { def_vfs_err(); }
	async sync(flags) {}
	async size() { def_vfs_err(); }
	async lock(lock_level) { def_vfs_err(); }
	async unlock(lock_level) { def_vfs_err(); }
	async check_reserved_lock() { def_vfs_err(); }
	file_control(op, arg) { return SQLITE_NOTFOUND; }
	device_characteristics() { return 0; }
}
function xClose(file) {
	const impl = file_impls.get(file);
	// console.log('xClose', impl);
	try {
		co_await(impl.close.bind(impl));
		return SQLITE_OK;
	} catch (e) {
		const vfs = memdv().getUint32(file + 4, true);
		last_errors.set(vfs, `${e.name}: ${e.message}`);
		return SQLITE_IOERR;
	}
}
function xRead(file, buff_ptr, buff_len, offset) {
	const impl = file_impls.get(file);
	const buffer = mem8(buff_ptr, buff_len);
	// console.log('xRead', impl, offset, buff_len);
	try {
		const read_len = co_await(impl.read.bind(impl), buffer, offset);
		if (read_len != suspended) {
			if (read_len < buff_len) {
				// Zero out the buffer.
				buffer.fill(0, read_len);
				return SQLITE_IOERR_SHORT_READ;
			} else {
				return SQLITE_OK;
			}
		}
	} catch (e) {
		const vfs = memdv().getUint32(file + 4, true);
		last_errors.set(vfs, `${e.name}: ${e.message}`);
		return SQLITE_IOERR;
	}
}
function xWrite(file, buff_ptr, buff_len, offset) {
	const impl = file_impls.get(file);
	const buffer = mem8(buff_ptr, buff_len);
	// console.log('xWrite', impl, offset, buff_len);
	try {
		const res = co_await(impl.write.bind(impl), buffer, offset);
		if (res != suspended) {
			return SQLITE_OK;
		}
	} catch (e) {
		const vfs = memdv().getUint32(file + 4, true);
		last_errors.set(vfs, `${e.name}: ${e.message}`);
		return SQLITE_IOERR;
	}
}
function xTruncate(file, size) {
	const impl = file_impls.get(file);
	// console.log('xTruncate', impl);
	try {
		const res = co_await(impl.truncate.bind(impl), size);
		if (res != suspended) { return SQLITE_OK; }
	} catch (e) {
		const vfs = memdv().getUint32(file + 4, true);
		last_errors.set(vfs, `${e.name}: ${e.message}`);
		return SQLITE_IOERR;
	}
}
function xSync(file, flags) {
	const impl = file_impls.get(file);
	// console.log('xSync', impl, flags);
	try {
		const res = co_await(impl.sync.bind(impl), flags);
		if (res != suspended) { return SQLITE_OK; }
	} catch (e) {
		const vfs = memdv().getUint32(file + 4, true);
		last_errors.set(vfs, `${e.name}: ${e.message}`);
		return SQLITE_IOERR;
	}
}
function xFileSize(file, size_ptr) {
	const impl = file_impls.get(file);
	console.log('xFileSize', impl);
	try {
		const res = co_await(impl.size.bind(impl));
		if (res != suspended) {
			memdv().setBigInt64(size_ptr, BigInt(size_ptr), true);
			return SQLITE_OK;
		}
	} catch (e) {
		const vfs = memdv().getUint32(file + 4, true);
		last_errors.set(vfs, `${e.name}: ${e.message}`);
		return SQLITE_IOERR;
	}
}
function xLock(file, lock_level) {
	const impl = file_impls.get(file);
	// console.log('xLock', impl, lock_level);
	try {
		const res = co_await(impl.lock.bind(impl), lock_level);
		if (res === false) { return SQLITE_BUSY; }
		return SQLITE_OK;
	} catch (e) {
		const vfs = memdv().getUint32(file + 4, true);
		last_errors.set(vfs, `${e.name}: ${e.message}`);
		return SQLITE_IOERR;
	}
}
function xUnlock(file, lock_level) {
	const impl = file_impls.get(file);
	// console.log('xUnlock', impl, lock_level);
	try {
		co_await(impl.unlock.bind(impl), lock_level);
		return SQLITE_OK;
	} catch (e) {
		const vfs = memdv().getUint32(file + 4, true);
		last_errors.set(vfs, `${e.name}: ${e.message}`);
		return SQLITE_IOERR;
	}
}
function xCheckReservedLock(file, res_ptr) {
	const impl = file_impls.get(file);
	// console.log('xCheckReservedLock', impl);
	try {
		const res = co_await(impl.check_reserved_lock.bind(impl));
		if (res != suspended) {
			memdv().setInt32(res_ptr, res ? 1 : 0);
			return SQLITE_OK;
		}
	} catch (e) {
		const vfs = memdv().getUint32(file + 4, true);
		last_errors.set(vfs, `${e.name}: ${e.message}`);
		return SQLITE_IOERR;
	}}
function xFileControl(file, op, arg) {
	const impl = file_impls.get(file);
	// console.log('xFileControl', impl, op, arg);
	try {
		const res = co_await(impl.file_control.bind(impl), op, arg);
		if (res == suspended) return;
		return res;
	} catch (e) {
		const vfs = memdv().getUint32(file + 4, true);
		last_errors.set(vfs, `${e.name}: ${e.message}`);
		return SQLITE_IOERR;
	}
}
function xSectorSize(file) {
	const impl = file_impls.get(file);
	// console.log('xSectorSize', impl);
	return impl.sector_size;
}
function xDeviceCharacteristics(file) {
	const impl = file_impls.get(file);
	// console.log('xDeviceCharacteristics', impl);
	const res = co_await(impl.device_characteristics.bind(impl));
	if (res != suspended) {
		return res;
	}
}

function sqlite3_os_init() {
	sqlite.set_logging();

	const vfs = allocate_vfs(new Vfs());
	if (vfs) {
		return sqlite.sqlite3_vfs_register(vfs, 1);
	} else {
		return SQLITE_ERROR;
	}
}
function sqlite3_os_end() {
	return SQLITE_OK;
}
function logging(_, code, msg) {
	const message = cstr_to_js(msg);
	console.log(`SQLite(${code}): ${message}`);
}

export async function connect(stack, pathname, flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE) {
	const ret_ptr = sqlite.malloc(4);
	if (!ret_ptr) {
		return;
	}
	const filename_ptr = js_to_cstr(pathname);
	if (!filename_ptr) {
		sqlite.free(ret_ptr);
		return;
	}

	const res = await re_enter(stack, sqlite.sqlite3_open_v2, filename_ptr, ret_ptr, flags, 0);

	const ret = memdv().getUint32(ret_ptr, true);
	sqlite.free(ret_ptr);
	sqlite.free(filename_ptr);
	
	handle_error(res);

	return ret;
}

// Sql object: { current: const char*, tail: const char*, stmt_out: sqlite3_stmt*, <...sql text> }
export function allocate_sql(sql) {
	if (!sql.endsWith('\0')) {
		sql += '\0';
	}
	const encoded = encoder.encode(sql);
	const ptr = sqlite.malloc(4 + 4 + 4 + encoded.byteLength);
	if (!ptr) return;
	const dv = memdv();
	dv.setUint32(ptr, ptr + 12, true);
	dv.setUint32(ptr + 4, ptr + 12 + encoded.byteLength, true)
	dv.setUint32(ptr + 8, 0, true);
	mem8(ptr + 12, encoded.byteLength).set(encoded);

	return ptr;
}

export async function prepare(stack, conn, sql, flags = 0) {
	const dv = memdv();
	const zSql = dv.getUint32(sql, true);
	const nByte = dv.getUint32(sql + 4, true) - zSql;
	if (nByte <= 1) return;

	const res = await re_enter(stack, sqlite.sqlite3_prepare_v3, conn, zSql, nByte, flags, sql + 8, sql);
	const stmt = memdv().getUint32(sql + 8, true);
	handle_error(res, conn);

	if (stmt == 0) return false;

	return stmt;
}
