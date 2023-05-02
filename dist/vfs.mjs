import { OutOfMemError } from "./asyncify.mjs";
import { sqlite3, imports, alloc_str, read_str, mem8, memdv, encoder, decoder, handle_error } from "./sqlite.mjs";
import {
	SQLITE_OK,
	SQLITE_IOERR, SQLITE_IOERR_SHORT_READ
} from "./sqlite_def.mjs";

const vfs_impls = new Map();
const last_errors = new Map();
const file_impls = new Map();
const file_vfs = new Map();

export function register_vfs(vfs_impl, make_default = false) {
	const name_ptr = alloc_str(vfs_impl.name);
	const vfs_ptr = sqlite3.allocate_vfs(name_ptr, vfs_impl.max_pathname);
	if (!vfs_ptr) throw new OutOfMemError();
	vfs_impls.set(vfs_ptr, vfs_impl);

	const res = sqlite3.sqlite3_vfs_register(vfs_ptr, make_default ? 1 : 0);

	handle_error(res);
}

imports['vfs'] = {
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
};
