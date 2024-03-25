/**
 * custom.js - Adds support for defining custom VFSs.
 * If you only ever use in-memory (:memory:) databases, then you don't need to import this file.
 * 
 * Currently, WAL is not support (disabled at compile time).  I think it's possible to support
 * WAL because browsers have shared memory, but I don't currently know how to do it.
 */
import './basics.js';
import { OutOfMemError, is_promise } from "../util.js";
import {
	default as initialized,
	sqlite3, imports, mem8, memdv,
} from "../sqlite.js";
import {
	SQLITE_OK, SQLITE_BUSY,
	SQLITE_IOERR, SQLITE_IOERR_SHORT_READ,
	SQLITE_FCNTL_VFS_POINTER, SQLITE_FCNTL_FILE_POINTER,
} from "../dist/sqlite_def.js";
import { Conn } from "../conn.js";
import { borrow_mem, leaky, encoder, str_read, handle_error } from "../memory.js";

const vfs_impls = new Map(); // ptr -> { vfs, errors }
const file_impls = new Map(); // ptr -> { file, errors }

// Expose access to the file / vfs on the connection
Object.assign(Conn.prototype, {
	vfs(db_name = 'main') {
		if (!this.ptr) return;

		return borrow_mem([4, db_name], (vfs_ptr_ptr, db_name) => {
			const res = sqlite3.sqlite3_file_control(this.ptr, db_name, SQLITE_FCNTL_VFS_POINTER, vfs_ptr_ptr);
			handle_error(res, this.ptr);
			const vfs_ptr = memdv().getInt32(vfs_ptr_ptr, true);
			const vfs = vfs_impls.get(vfs_ptr)?.vfs;
			return vfs;
		});
	},
	file(db_name = 'main') {
		if (!this.ptr) return;

		return borrow_mem([4, db_name], (file_ptr_ptr, db_name) => {
			const res = sqlite3.sqlite3_file_control(this.ptr, db_name, SQLITE_FCNTL_FILE_POINTER, file_ptr_ptr);
			handle_error(res, this.ptr);
			const file_ptr = memdv().getInt32(file_ptr_ptr, true);
			const file = file_impls.get(file_ptr)?.file;
			return file;
		});
	}
});

export async function register_vfs(vfs, make_default = false) {
	await initialized;
	const vfs_ptr = sqlite3.allocate_vfs(leaky(vfs.name), vfs.max_pathname);
	if (!vfs_ptr) throw new OutOfMemError();
	vfs_impls.set(vfs_ptr, { vfs, errors: []});

	const res = sqlite3.sqlite3_vfs_register(vfs_ptr, make_default ? 1 : 0);

	handle_error(res);
}

class Filename {
	#ptr;
	constructor(ptr) {
		this.#ptr = ptr;
	}
	[Symbol.toPrimitive](_hint) {
		if (this.#ptr == 0) {
			return crypto.getRandomValues(new Uint8Array(8)).reduce((a, i) => a + i.toString(16).padStart(2, '0')) + '.tmp';
		}
		return str_read(this.#ptr);
	}
	get_parameter(param, def_val) {
		return borrow_mem([param], (param) => {
			if (typeof def_val == 'boolean') {
				const res = sqlite3.sqlite3_uri_boolean(this.#ptr, param, Number(def_val));
				return Boolean(res);
			}
			else if (typeof def_val == 'number') {
				return Number(sqlite3.sqlite3_uri_int64(this.#ptr, param, BigInt(def_val)));
			}
			else if (typeof def_val == 'bigint') {
				return sqlite3.sqlite3_uri_int64(this.#ptr, param, def_val);
			}
			else {
				const res = sqlite3.sqlite3_uri_parameter(this.#ptr, param);
				return res ? str_read(res) : def_val;
			}
		});
	}
	*[Symbol.iterator]() {
		for (let i = 0; true; ++i) {
			const param_ptr = sqlite3.sqlite3_uri_key(this.#ptr, i);
			if (!param_ptr) break;
			const param = str_read(param_ptr);
			const val_ptr = sqlite3.sqlite3_uri_parameter(this.#ptr, param_ptr);
			const val = str_read(val_ptr);
			yield [param, val];
		}
	}
}

function vfs_boiler(vfs_ptr, method_name, args = [], success = () => SQLITE_OK, error = () => SQLITE_IOERR) {
	const {vfs, errors} = vfs_impls.get(vfs_ptr) ?? {};
	if (!vfs) return error();

	const err = e => {console.warn(e); return error() };
	const suc = res => success(res, {vfs, errors});
	
	try {
		const ret = vfs[method_name](...args);
		if (is_promise(ret)) return ret.then(suc, err);
		return suc(ret);
	} catch (e) {
		return err(e);
	}
}
function file_boiler(file_ptr, method_name, args = [], success = () => SQLITE_OK, error = () => SQLITE_IOERR) {
	const {file, errors} = file_impls.get(file_ptr) ?? {};
	if (!file) return error();

	const err = e => {console.warn(e); return error() };
	const suc = res => success(res, {file, errors});

	try {
		const ret = file[method_name](...args);
		if (is_promise(ret)) return ret.then(suc, err);
		return suc(ret);
	} catch (e) {
		return err(e);
	}
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

imports['vfs'] ??= {};
Object.assign(imports['vfs'], {
	// sqlite3_vfs methods:
	xOpen(vfs_ptr, filename_ptr, file_out, flags, flags_out) {
		return vfs_boiler(vfs_ptr, 'open', [new Filename(filename_ptr), flags], (file, {errors}) => {
			file_impls.set(file_out, {file, errors});
			memdv().setInt32(flags_out, file.flags, true);
			return SQLITE_OK;
		}, () => {
			memdv().setInt32(file_out, 0, true);
			return SQLITE_IOERR;
		});
	},
	xDelete(vfs_ptr, filename_ptr, sync) {
		return vfs_boiler(vfs_ptr, 'delete', [new Filename(filename_ptr), sync]);
	},
	xAccess(vfs_ptr, filename_ptr, flags, result_ptr) {
		return vfs_boiler(vfs_ptr, 'access', [new Filename(filename_ptr), flags], res => {
			memdv().setInt32(result_ptr, Number(res), true);
			return SQLITE_OK;
		});
	},
	xFullPathname(vfs_ptr, filename_ptr, buff_len, buff_ptr) {
		return vfs_boiler(vfs_ptr, 'full_pathname', [str_read(filename_ptr)], full => {
			if (!full.endsWith('\0')) full += '\0';
			encoder.encodeInto(full, mem8(buff_ptr, buff_len));
			return SQLITE_OK;
		});
	},
	xGetLastError(vfs_ptr, buff_len, buff_ptr) {
		const {errors} = vfs_impls.get(vfs_ptr) ?? {};
		const msg = errors ? String(String(errors.at(-1) ?? 'no error?')) : "vfs_impls doesn't have an entry for this vfs_ptr";
		encoder.encodeInto(msg, mem8(buff_ptr, buff_len));
		return SQLITE_IOERR;
	},
	// sqlite3_io_methods methods:
	xClose(file_ptr) {
		return file_boiler(file_ptr, 'close', [], () => {
			file_impls.delete(file_ptr);
			return SQLITE_OK;
		}, () => {
			file_impls.delete(file_ptr);
			return SQLITE_IOERR;
		});
	},
	xRead(file_ptr, buff_ptr, buff_len, offset) {
		console.assert(offset < MAX_SAFE, 'Offset overflow!');
		return file_boiler(file_ptr, 'read', [offset, buff_len], read => {
			mem8(buff_ptr, buff_len).set(read);
			if (read.byteLength < buff_len) {
				mem8(buff_ptr + read.byteLength, buff_len - read.byteLength).fill(0);
				return SQLITE_IOERR_SHORT_READ;
			}
			return SQLITE_OK;
		});
	},
	xWrite(file_ptr, buff_ptr, buff_len, offset) {
		console.assert(offset < MAX_SAFE, 'Offset overflow!');
		return file_boiler(file_ptr, 'write', [mem8(buff_ptr, buff_len), offset]);
	},
	xTruncate(file_ptr, size) {
		console.assert(size < MAX_SAFE, 'Offset overflow!');
		return file_boiler(file_ptr, 'trunc', [size]);
	},
	xSync(file_ptr, flags) {
		return file_boiler(file_ptr, 'sync', [flags]);
	},
	xFileSize(file_ptr, size_ptr) {
		return file_boiler(file_ptr, 'size', [], size => {
			memdv().setBigInt64(size_ptr, BigInt(size), true);
			return SQLITE_OK;
		});
	},
	xLock(file_ptr, lock_level) {
		return file_boiler(file_ptr, 'lock', [lock_level], res => res ? SQLITE_OK : SQLITE_BUSY);
	},
	xUnlock(file_ptr, lock_level) {
		return file_boiler(file_ptr, 'unlock', [lock_level]);
	},
	xCheckReservedLock(file_ptr, res_ptr) {
		return file_boiler(file_ptr, 'check_reserved_lock', [], res => {
			memdv().setInt32(res_ptr, Number(res), true);
			return SQLITE_OK;
		});
	},
	xFileControl(file_ptr, op, arg) {
		return file_boiler(file_ptr, 'file_control', [op, arg], res => res);
	},
	xSectorSize(file_ptr) {
		const {file} = file_impls.get(file_ptr) ?? {};
		return file?.sector_size ?? 0;
	},
	xDeviceCharacteristics(file_ptr) {
		const {file} = file_impls.get(file_ptr) ?? {};
		return file?.device_characteristics() ?? 0;
	}
});
