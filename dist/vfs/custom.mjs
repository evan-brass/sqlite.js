/**
 * custom.mjs - Adds support for defining custom VFSs.
 * If you only ever use in-memory (:memory:) databases, then you don't need to import this file.
 * 
 * Currently, WAL is not support (disabled at compile time).  I think it's possible to support
 * WAL because browsers have shared memory, but I don't currently know how to do it.
 */
import './basics.mjs';
import { OutOfMemError } from "../asyncify.mjs";
import { sqlite3, imports, alloc_str, read_str, mem8, memdv, encoder, handle_error } from "../sqlite.mjs";
import {
	SQLITE_OK,
	SQLITE_IOERR, SQLITE_IOERR_SHORT_READ
} from "../sqlite_def.mjs";

const vfs_impls = new Map(); // ptr -> { vfs_impl, errors }
const file_impls = new Map(); // ptr -> { file_impl, vfs: { vfs_impl, errors } }

export function register_vfs(impl, make_default = false) {
	const name_ptr = alloc_str(impl.name);
	if (!name_ptr) throw new OutOfMemError();
	const vfs_ptr = sqlite3.allocate_vfs(name_ptr, impl.max_pathname);
	if (!vfs_ptr) throw new OutOfMemError();
	vfs_impls.set(vfs_ptr, { impl, errors: []});

	const res = sqlite3.sqlite3_vfs_register(vfs_ptr, make_default ? 1 : 0);

	handle_error(res);
}

function get_vfs(vfs_ptr, filename_ptr) {
	let vfs = vfs_impls.get(vfs_ptr);
	if (!vfs) {
		// This must be the default VFS (for which we don't have an entry in vfs_impls) or it could be a vfs that wasn't registered through register_vfs.  If it's the later case, then we're screwed.
		// If we decide that the default VFS only supports in-memory databases, then we should error out.  If, however, we instead choose to have the default VFS dispatch to the proper VFS based on the protocol, then this is where we would find the proper VFS using the sqlite3_filename.
		throw new Error("The base VFS currently only supports in-memory databases.  You'll need to register and use a different VFS implementation.");
	}
	return vfs.vfs_impl;
}
function set_error(vfs, e) {
	vfs.errors.push(e);
	console.error(e);
	return SQLITE_IOERR;
}

class Filename {
	#ptr;
	constructor(ptr) {
		this.#ptr = ptr;
	}
	[Symbol.toPrimitive](_hint) {
		return read_str(this.#ptr);
	}
	get_parameter(param, def_val) {
		const param_ptr = alloc_str(param);
		if (!param_ptr) throw new OutOfMemError();
		try {
			if (typeof def_val == 'boolean') {
				const res = sqlite3.sqlite3_uri_boolean(this.#ptr, param_ptr, Number(def_val));
				return Boolean(res);
			}
			else if (typeof def_val == 'number' || typeof def_val == 'bigint') {
				return sqlite3.sqlite3_uri_int64(this.#ptr, param_ptr, BigInt(def_val));
			}
			else {
				const res = sqlite3.sqlite3_uri_parameter(this.#ptr, param_ptr);
				return res ? read_str(res) : undefined;
			}
		} finally {
			sqlite3.free(param_ptr);
		}
	}
	*[Symbol.iterator]() {
		let i = 0;
		while (1) {
			const param_ptr = sqlite3.sqlite3_uri_key(this.#ptr, i);
			if (!param_ptr) break;
			const param = read_str(param_ptr);
			const val_ptr = sqlite3.sqlite3_uri_parameter(this.#ptr, param_ptr);
			const val = read_str(val_ptr);
			yield [param, val];
		}
	}
}

imports['vfs'] ??= {};
Object.assign(imports['vfs'], {
	// sqlite3_vfs methods:
	async xOpen(vfs_ptr, filename_ptr, file_out, flags, flags_out) {
		const vfs = vfs_impls.get(vfs_ptr);
		const filename = new Filename(filename_ptr);
		try {
			const file = await vfs.impl.open(filename, flags);
			file_impls.set(file_out, { impl: file, vfs });
			memdv().setInt32(flags_out, file.flags, true);
			
			return SQLITE_OK;
		} catch (e) { return set_error(vfs, e); }
	},
	async xDelete(vfs_ptr, filename_ptr, sync) {
		const vfs = vfs_impls.get(vfs_ptr);
		const filename = new Filename(filename_ptr);
		try {
			await vfs.impl.delete(filename, sync);
	
			return SQLITE_OK;
		} catch (e) { return set_error(vfs, e); }
	},
	async xAccess(vfs_ptr, filename_ptr, flags, result_ptr) {
		const vfs = vfs_impls.get(vfs_ptr);
		const filename = new Filename(filename_ptr);
		try {
			const res = await vfs.impl.access(filename, flags);
			memdv().setInt32(result_ptr, res ? 1 : 0);
	
			return SQLITE_OK;
		} catch (e) { return set_error(vfs, e); }
	},
	async xFullPathname(vfs_ptr, filename_ptr, buff_len, buff_ptr) {
		const vfs = vfs_impls.get(vfs_ptr);
		const filename = new Filename(filename_ptr);
		try {
			let full = await vfs.impl.full_pathname(filename);
			full = String(full);
			if (!full.endsWith('\0')) full += '\0';
			encoder.encodeInto(full, mem8(buff_ptr, buff_len));

			return SQLITE_OK;
		} catch (e) { return set_error(vfs, e); }
	},
	xGetLastError(vfs_ptr, buff_len, buff_ptr) {
		const { errors } = vfs_impls.get(vfs_ptr);
		const e = errors[errors.length];
		let msg = e ? `${e.name}: ${e.message}` : '<No Error>';
		if (!msg.endsWith('\0')) msg += '\0';
		encoder.encodeInto(msg, mem8(buff_ptr, buff_len));

		return SQLITE_OK;
	},
	// sqlite3_io_methods methods:
	async xClose(file_ptr) {
		const file = file_impls.get(file_ptr);
		try {
			await file.impl.close();

			return SQLITE_OK;
		} catch (e) { return set_error(file.vfs, e); }
	},
	async xRead(file_ptr, buff_ptr, buff_len, offset) {
		const file = file_impls.get(file_ptr);
		try {
			const read = await file.impl.read(offset, buff_len);
			mem8(buff_ptr, read.byteLength).set(read);
			if (read.byteLength < buff_len) {
				// Zero out the buffer.
				mem8(buff_ptr + read.byteLength, buff_len - read.byteLength).fill(0);

				return SQLITE_IOERR_SHORT_READ;
			}

			return SQLITE_OK;
		} catch (e) { return set_error(file.vfs, e); }
	},
	async xWrite(file_ptr, buff_ptr, buff_len, offset) {
		const file = file_impls.get(file_ptr);
		try {
			await file.impl.write(mem8(buff_ptr, buff_len), offset);

			return SQLITE_OK;
		} catch (e) { return set_error(file.vfs, e); }
	},
	async xTruncate(file_ptr, size) {
		const file = file_impls.get(file_ptr);
		try {
			await file.impl.truncate(size);

			return SQLITE_OK;
		} catch (e) { return set_error(file.vfs, e); }
	},
	async xSync(file_ptr, flags) {
		const file = file_impls.get(file_ptr);
		try {
			await file.impl.sync(flags);

			return SQLITE_OK;
		} catch (e) { return set_error(file.vfs, e); }
	},
	async xFileSize(file_ptr, size_ptr) {
		const file = file_impls.get(file_ptr);
		try {
			const size = await file.impl.size();
			memdv().setBigInt64(size_ptr, BigInt(size), true);

			return SQLITE_OK;
		} catch (e) { return set_error(file.impl, e); }
	},
	async xLock(file_ptr, lock_level) {
		const file = file_impls.get(file_ptr);
		try {
			const res = await file.impl.lock(lock_level);

			return res ? SQLITE_OK : SQLITE_BUSY;
		} catch (e) { return set_error(file.vfs, e); }
	},
	async xUnlock(file_ptr, lock_level) {
		const file = file_impls.get(file_ptr);
		try {
			await file.impl.unlock(lock_level);

			return SQLITE_OK;
		} catch (e) { return set_error(file.vfs, e); }
	},
	async xCheckReservedLock(file_ptr, res_ptr) {
		const file = file_impls.get(file_ptr);
		try {
			const res = await file.impl.check_reserved_lock();
			memdv().setInt32(res_ptr, Number(res), true);

			return SQLITE_OK;
		} catch (e) { return set_error(file.vfs, e); }
	},
	async xFileControl(file_ptr, op, arg) {
		const file = file_impls.get(file_ptr);
		try {
			const res = await file.impl.file_control(op, arg);

			return res;
		} catch (e) { return set_error(file.vfs, e); }
	},
	xSectorSize(file_ptr) {
		const file = file_impls.get(file_ptr);
		return file.impl.sector_size;
	},
	xDeviceCharacteristics(file_ptr) {
		const file = file_impls.get(file_ptr);
		return file.impl.device_characteristics();
	}
});
