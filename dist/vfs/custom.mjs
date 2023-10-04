/**
 * custom.mjs - Adds support for defining custom VFSs.
 * If you only ever use in-memory (:memory:) databases, then you don't need to import this file.
 * 
 * Currently, WAL is not support (disabled at compile time).  I think it's possible to support
 * WAL because browsers have shared memory, but I don't currently know how to do it.
 */
import './basics.mjs';
import { OutOfMemError, is_promise } from "../util.mjs";
import {
	sqlite3, imports, mem8, memdv, 
} from "../sqlite.mjs";
import {
	SQLITE_OK, SQLITE_BUSY,
	SQLITE_IOERR, SQLITE_IOERR_SHORT_READ, SQLITE_OPEN_EXRESCODE, SQLITE_OPEN_READONLY, SQLITE_OPEN_READWRITE,
	SQLITE_FCNTL_VFS_POINTER, SQLITE_FCNTL_FILE_POINTER,
} from "../sqlite_def.mjs";
import { Conn } from "../conn.mjs";
import { borrow_mem, leaky, encoder, str_read, handle_error } from "sql.mjs/memory.mjs";

const vfs_impls = new Map(); // ptr -> { vfs, errors }
const file_impls = new Map(); // ptr -> { file, errors }

// Expose access to the file / vfs on the connection
Object.assign(Conn.prototype, {
	vfs(db_name = 'main') {
		if (!this.ptr) return;

		return borrow_mem([4, db_name], (vfs_ptr_ptr, db_name) => {
			const res = sqlite3.sqlite3_file_control(this.ptr, db_name, SQLITE_FCNTL_VFS_POINTER, vfs_ptr_ptr);
			handle_error(res);
			const vfs_ptr = memdv().getInt32(vfs_ptr_ptr, true);
			const vfs = vfs_impls.get(vfs_ptr)?.vfs;
			return vfs;
		});
	},
	file(db_name = 'main') {
		if (!this.ptr) return;

		return borrow_mem([4, db_name], (file_ptr_ptr, db_name) => {
			const res = sqlite3.sqlite3_file_control(this.ptr, db_name, SQLITE_FCNTL_FILE_POINTER, file_ptr_ptr);
			handle_error(res);
			const file_ptr = memdv().getInt32(file_ptr_ptr, true);
			const file = file_impls.get(file_ptr)?.file;
			return file;
		});
	}
});

export function register_vfs(vfs, make_default = false) {
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

function vfs_wrapper(inner) {
	return async function (vfs_ptr, ...args) {
		const entry = vfs_impls.get(vfs_ptr);
		if (!entry) throw new Error('vfs implementation not found... was it registered using register_vfs?');
		const { vfs, errors } = entry;

		try {
			return await inner({vfs, errors, vfs_ptr}, ...args);
		} catch (e) {
			errors.push(e);
			console.error(e);
			return SQLITE_IOERR;
		}
	}
}
function file_wrapper(inner) {
	return async function (file_ptr, ...args) {
		const entry = file_impls.get(file_ptr);
		if (!entry) throw new Error('file implementation not found... this is pretty weird, did you mannually call sqlite3_open?  Could also be a problem in the cleanup for closed files.');
		const { file, errors } = entry;

		try {
			return await inner({file, errors, file_ptr}, ...args);
		} catch (e) {
			errors.push(e);
			console.error(e);
			return SQLITE_IOERR;
		}
	}
}

//
function maybe_async(f, success = () => SQLITE_OK, fail = () => SQLITE_IOERR) {
	try {
		const ret = f();
		if (is_promise(ret)) {
			return ret.then(success, fail);
		}
		return success(ret);
	} catch (e) {
		return fail(e);
	}
}

imports['vfs'] ??= {};
Object.assign(imports['vfs'], {
	// sqlite3_vfs methods:
	xOpen(vfs_ptr, filename_ptr, file_out, flags, flags_out) {
		// In the event of a failure, we clear .pMethods of the file_out so that SQLite doesn't call close on it.
		const clear_pMethods = () => memdv().setInt32(file_out, 0, true);
		
		const {vfs, errors} = vfs_impls.get(vfs_ptr) ?? {};
		if (!vfs) {
			// If we don't have an entry for the vfs in our vfs_impls then it wasn't registered with register_vfs: it is either the in-memory vfs that gets registered during sqlite_os_init or someone tried to sqlite_vfs_register on their own.  Either way, we error:
			clear_pMethods();
			return SQLITE_IOERR;
		}

		const filter = SQLITE_OPEN_EXRESCODE | (vfs.flags_filter ?? (SQLITE_OPEN_READONLY | SQLITE_OPEN_READWRITE));
		const success = file => {
			memdv().setInt32(flags_out, file.flags ?? 0, true);
			file_impls.set(file_out, {file, errors});
			return SQLITE_OK;
		};
		const fail = error => {
			errors.push(error);
			clear_pMethods();
			return SQLITE_IOERR;
		};
		return maybe_async(() => vfs.open(new Filename(filename_ptr), flags & filter), success, fail);
	},
	xDelete(vfs_ptr, filename_ptr, sync) {
		const {vfs, errors} = vfs_impls.get(vfs_ptr) ?? {};
		if (!vfs) return SQLITE_IOERR;
		return maybe_async(() => vfs.delete(new Filename(filename_ptr), sync), () => SQLITE_OK, e => {
			errors.push(e);
			return SQLITE_IOERR;
		});
	},
	xAccess(vfs_ptr, filename_ptr, flags, result_ptr) {
		const {vfs, errors} = vfs_impls.get(vfs_ptr) ?? {};
		if (!vfs) return SQLITE_IOERR;
		return maybe_async(() => vfs.access(new Filename(filename_ptr), flags), res => {
			memdv().setInt32(result_ptr, Number(res), true);
			return SQLITE_OK;
		}, e => {
			errors.push(e);
			return SQLITE_IOERR;
		});
	},
	xFullPathname(vfs_ptr, filename_ptr, buff_len, buff_ptr) {
		const {vfs, errors} = vfs_impls.get(vfs_ptr) ?? {};
		if (!vfs) return SQLITE_IOERR;
		maybe_async(() => vfs.full_pathname(str_read(filename_ptr)), full => {
			if (!full.endsWith('\0')) full += '\0';
			encoder.encodeInto(full, mem8(buff_ptr, buff_len));
			return SQLITE_OK;
		}, e => {
			errors.push(e);
			return SQLITE_IOERR;
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
		const {file, errors} = file_impls.get(file_ptr) ?? {};
		if (!file) return SQLITE_IOERR;
		file_impls.delete(file_ptr);
		maybe_async(() => file.close(), () => {
			return SQLITE_OK;
		}, e => {
			errors.push(e);
			return SQLITE_IOERR;
		});
	},
	xRead(file_ptr, buff_ptr, buff_len, offset) {
		const {file, errors} = file_impls.get(file_ptr) ?? {};
		if (!file) return SQLITE_IOERR;
		maybe_async(() => file.read(offset, buff_len), read => {
			mem8(buff_ptr, buff_len).set(read);
			if (read.byteLength < buff_len) {
				// Zero out the end of the buffer:
				mem8(buff_ptr + read.byteLength, buff_len - read.byteLength).fill(0);
				return SQLITE_IOERR_SHORT_READ;
			}
			return SQLITE_OK;
		}, e => {
			errors.push(e);
			return SQLITE_IOERR;
		});
	},
	xWrite(file_ptr, buff_ptr, buff_len, offset) {
		const {file, errors} = file_impls.get(file_ptr) ?? {};
		if (!file) return SQLITE_IOERR;
		maybe_async(() => file.write(mem8(buff_ptr, buff_len), offset), () => SQLITE_OK, e => {
			errors.push(e);
			return SQLITE_IOERR;
		});
	},
	xTruncate(file_ptr, size) {
		const {file, errors} = file_impls.get(file_ptr) ?? {};
		if (!file) return SQLITE_IOERR;
		maybe_async(() => file.trunc(size), () => SQLITE_OK, e => {
			errors.push(e);
			return SQLITE_IOERR;
		});
	},
	xSync(file_ptr, flags) {
		const {file, errors} = file_impls.get(file_ptr) ?? {};
		if (!file) return SQLITE_IOERR;
		maybe_async(() => file.sync(flags), () => SQLITE_OK, e => {
			errors.push(e);
			return SQLITE_IOERR;
		});
	},
	xFileSize(file_ptr, size_ptr) {
		const {file, errors} = file_impls.get(file_ptr) ?? {};
		if (!file) return SQLITE_IOERR;
		maybe_async(() => file.size(), size => {
			memdv().setBigInt64(size_ptr, BigInt(size), true);
			return SQLITE_OK;
		}, e => {
			errors.push(e);
			return SQLITE_IOERR;
		});
	},
	xLock(file_ptr, lock_level) {
		const {file, errors} = file_impls.get(file_ptr) ?? {};
		if (!file) return SQLITE_IOERR;
		maybe_async(() => file.lock(lock_level), () => SQLITE_OK, e => {
			errors.push(e);
			return SQLITE_IOERR;
		});
	},
	xUnlock(file_ptr, lock_level) {
		const {file, errors} = file_impls.get(file_ptr) ?? {};
		if (!file) return SQLITE_IOERR;
		maybe_async(() => file.unlock(lock_level), () => SQLITE_OK, e => {
			errors.push(e);
			return SQLITE_IOERR;
		});
	},
	xCheckReservedLock(file_ptr, res_ptr) {
		const {file, errors} = file_impls.get(file_ptr) ?? {};
		if (!file) return SQLITE_IOERR;
		maybe_async(() => file.check_reserved_lock(), res => {
			memdv().setInt32(res_ptr, Number(res), true);
			return SQLITE_OK;
		}, e => {
			errors.push(e);
			return SQLITE_IOERR;
		});
	},
	xFileControl(file_ptr, op, arg) {
		const {file, errors} = file_impls.get(file_ptr) ?? {};
		if (!file) return SQLITE_IOERR;
		maybe_async(() => file.file_control(op, arg), () => SQLITE_OK, e => {
			errors.push(e);
			return SQLITE_IOERR;
		});
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
