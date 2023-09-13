/**
 * custom.mjs - Adds support for defining custom VFSs.
 * If you only ever use in-memory (:memory:) databases, then you don't need to import this file.
 * 
 * Currently, WAL is not support (disabled at compile time).  I think it's possible to support
 * WAL because browsers have shared memory, but I don't currently know how to do it.
 */
import './basics.mjs';
import { OutOfMemError } from "../util.mjs";
import {
	sqlite3, imports, read_str, mem8, memdv, encoder, handle_error,
	vfs_impls, file_impls
} from "../sqlite.mjs";
import {
	SQLITE_OK,
	SQLITE_IOERR, SQLITE_IOERR_SHORT_READ, SQLITE_OPEN_EXRESCODE, SQLITE_OPEN_READONLY, SQLITE_OPEN_READWRITE
} from "../sqlite_def.mjs";
import { dyn_s } from '../strings.mjs';

// SQLite calls .close on files, even if they fail to open... but we don't get a file_impl unless the open succeeds, so FakeFile just stops that from being an error.
class FakeFile { close() { /* No Op */ } }

export function register_vfs(vfs, make_default = false) {
	const name = dyn_s(vfs.name);
	if (!name) throw new OutOfMemError();
	const vfs_ptr = sqlite3.allocate_vfs(name, vfs.max_pathname);
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
		return read_str(this.#ptr);
	}
	get_parameter(param, def_val) {
		param = dyn_s(param);
		if (!param) throw new OutOfMemError();
		try {
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
				return res ? read_str(res) : def_val;
			}
		} finally {
			sqlite3.free(param);
		}
	}
	*[Symbol.iterator]() {
		for (let i = 0; true; ++i) {
			const param_ptr = sqlite3.sqlite3_uri_key(this.#ptr, i);
			if (!param_ptr) break;
			const param = read_str(param_ptr);
			const val_ptr = sqlite3.sqlite3_uri_parameter(this.#ptr, param_ptr);
			const val = read_str(val_ptr);
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

imports['vfs'] ??= {};
Object.assign(imports['vfs'], {
	// sqlite3_vfs methods:
	xOpen: vfs_wrapper(async function xOpen({vfs, errors}, filename_ptr, file_out, flags, flags_out) {
		const filename = new Filename(filename_ptr);
		const filter = SQLITE_OPEN_EXRESCODE | (vfs.flags_filter ?? (SQLITE_OPEN_READONLY | SQLITE_OPEN_READWRITE));
		let file;
		try {
			file = await vfs.open(filename, flags & filter);
			memdv().setInt32(flags_out, file.flags, true);
			return SQLITE_OK;
		} finally {
			file_impls.set(file_out, { file: file ?? new FakeFile(), errors });
		}
	}),
	xDelete: vfs_wrapper(async function xDelete({vfs}, filename_ptr, sync) {
		const filename = new Filename(filename_ptr);
		await vfs.delete(filename, sync);
		return SQLITE_OK;
	}),
	xAccess: vfs_wrapper(async function xAccess({vfs}, filename_ptr, flags, result_ptr) {
		const filename = new Filename(filename_ptr);
		const res = await vfs.access(filename, flags);
		memdv().setInt32(result_ptr, res ? 1 : 0);
		return SQLITE_OK;
	}),
	xFullPathname: vfs_wrapper(async function xFullPathname({vfs}, filename_ptr, buff_len, buff_ptr) {
		const filename = read_str(filename_ptr);
		let full = await vfs.full_pathname(filename);
		if (!full.endsWith('\0')) full += '\0';
		encoder.encodeInto(full, mem8(buff_ptr, buff_len));
		return SQLITE_OK;
	}),
	xGetLastError: vfs_wrapper(function xGetLastError({errors}, buff_len, buff_ptr) {
		const e = errors[errors.length];
		let msg = e ? `${e.name}: ${e.message}\0` : '<No Error>\0';
		encoder.encodeInto(msg, mem8(buff_ptr, buff_len));
		return SQLITE_OK;
	}),
	// sqlite3_io_methods methods:
	xClose: file_wrapper(async function xClose({file, file_ptr}) {
		try {
			await file.close();
			return SQLITE_OK;
		} finally {
			file_impls.delete(file_ptr);
		}
	}),
	xRead: file_wrapper(async function xRead({file}, buff_ptr, buff_len, offset) {
		const read = await file.read(offset, buff_len);
		mem8(buff_ptr, read.byteLength).set(read);
		if (read.byteLength < buff_len) {
			// Zero out the buffer.
			mem8(buff_ptr + read.byteLength, buff_len - read.byteLength).fill(0);
			return SQLITE_IOERR_SHORT_READ;
		}
		return SQLITE_OK;
	}),
	xWrite: file_wrapper(async function xWrite({file}, buff_ptr, buff_len, offset) {
		await file.write(mem8(buff_ptr, buff_len), offset);
		return SQLITE_OK;
	}),
	xTruncate: file_wrapper(async function xTruncate({file}, size) {
		await file.trunc(size);
		return SQLITE_OK;
	}),
	xSync: file_wrapper(async function xSync({file}, flags) {
		await file.sync(flags);
		return SQLITE_OK;
	}),
	xFileSize: file_wrapper(async function xFileSize({file}, size_ptr) {
		const size = await file.size();
		memdv().setBigInt64(size_ptr, BigInt(size), true);
		return SQLITE_OK;
	}),
	xLock: file_wrapper(async function xLock({file}, lock_level) {
		const res = await file.lock(lock_level);
		return res ? SQLITE_OK : SQLITE_BUSY;
	}),
	xUnlock: file_wrapper(async function xUnlock({file}, lock_level) {
		await file.unlock(lock_level);
		return SQLITE_OK;
	}),
	xCheckReservedLock: file_wrapper(async function xCheckReservedLock({file}, res_ptr) {
		const res = await file.check_reserved_lock();
		memdv().setInt32(res_ptr, Number(res), true);
		return SQLITE_OK;
	}),
	xFileControl: file_wrapper(async function xFileControl({file}, op, arg) {
		const res = await file.file_control(op, arg);
		return res;
	}),
	xSectorSize: file_wrapper(function xSectorSize({file}) {
		return file.sector_size;
	}),
	xDeviceCharacteristics: file_wrapper(function xDeviceCharacteristics({file}) {
		return file.device_characteristics();
	})
});
