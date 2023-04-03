import { Vfs, VfsFile } from './sql.mjs';
import { SQLITE_OK, SQLITE_ACCESS_EXISTS, SQLITE_FCNTL_BEGIN_ATOMIC_WRITE, SQLITE_FCNTL_COMMIT_ATOMIC_WRITE, SQLITE_FCNTL_ROLLBACK_ATOMIC_WRITE, SQLITE_IOCAP_ATOMIC, SQLITE_IOCAP_BATCH_ATOMIC, SQLITE_NOTFOUND, SQLITE_OPEN_CREATE, SQLITE_OPEN_DELETEONCLOSE } from './sqlite_def.mjs';

const dir = await navigator.storage.getDirectory();

class OpfsFile extends VfsFile {
	#handle;
	#lock;
	#writable = false;
	flags = 0;
	sector_size = 0;
	constructor(handle, _flags) {
		super();
		this.#handle = handle;
		this.flags = 0;
	}
	get lock_name() {
		return `opfs.mjs:${this.#handle.name}`;
	}
	get lock_name_reserved() {
		return this.lock_name + '-r';
	}
	async close() {
		// console.log(this.#handle.name, 'close');
		if (this.flags & SQLITE_OPEN_DELETEONCLOSE) {
			await this.#handle.remove();
		}
	}
	sync() {
		// console.log(this.#handle.name, 'sync');
		// Do Nothing.
	}
	async read(offset, len) {
		// console.log(this.#handle.name, 'read', len, 'at', offset);
		offset = Number(offset);
		if (this.#writable) throw new Error();
		const file = await this.#handle.getFile();
		const section = file.slice(offset, offset + len);
		const data = new Uint8Array(await section.arrayBuffer());
		// console.log(data);
		return data;
	}
	async write(buffer, offset) {
		// console.log(this.#handle.name, 'write', buffer.byteLength, 'at', offset);
		// console.log(buffer.slice());
		if (!this.#writable) throw new Error();
		await this.#writable.write({ type: 'write', data: buffer, position: Number(offset) });
	}
	async file_control(op, arg) {
		// console.log(this.#handle.name, 'control', op, arg);
		if (op == SQLITE_FCNTL_BEGIN_ATOMIC_WRITE) {
			this.#writable = await this.#handle.createWritable({keepExistingData: true});
			return SQLITE_OK;
		}
		else if (op == SQLITE_FCNTL_COMMIT_ATOMIC_WRITE) {
			await this.#writable.close();
			this.#writable = false;
			return SQLITE_OK;
		}
		else if (op == SQLITE_FCNTL_ROLLBACK_ATOMIC_WRITE) {
			await this.#writable.abort();
			this.#writable = false;
			return SQLITE_OK;
		} else {
			return super.file_control(op, arg);
		}
	}
	async trunc(length) {
		if (this.#writable) throw new Error();
		// console.log(this.#handle.name, 'trunc', length);
		const writable = await this.#handle.createWritable({keepExistingData: true});
		await writable.truncate(Number(length));
		await writable.close();
	}
	async size() {
		// console.log(this.#handle.name, 'size');
		const file = await this.#handle.getFile();
		return BigInt(file.size);
	}
	lock(lock_level) {
		// console.log(this.#handle.name, 'lock', lock_level);
		if (this.#lock?.mode == 'exclusive') return true;

		return new Promise(ret => {
			navigator.locks.request(this.lock_name, {mode: 'exclusive', ifAvailable: true}, lock => new Promise(res => {
				if (lock) {
					this.#lock = lock;
					this.#lock.release = res;
					ret(true);
				} else {
					ret(false);
				}
			}));
		});
	}
	unlock(lock_level) {
		// console.log(this.#handle.name, 'unlock', lock_level);
		if (lock_level == 0) {
			this.#lock.release();
			this.#lock = false;
		}
	}
	check_reserved_lock() {
		throw new Error();
	}
	sector_size() { return 1; }
	device_characteristics() {
		// console.log(this.#handle.name, 'iocap');
		// return SQLITE_IOCAP_BATCH_ATOMIC | SQLITE_IOCAP_SAFE_APPEND | SQLITE_IOCAP_SEQUENTIAL | SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN;
		// return 0;
		// return SQLITE_IOCAP_ATOMIC | SQLITE_IOCAP_SAFE_APPEND | SQLITE_IOCAP_SEQUENTIAL | SQLITE_IOCAP_BATCH_ATOMIC;
		// return SQLITE_IOCAP_SEQUENTIAL;
		return SQLITE_IOCAP_ATOMIC | SQLITE_IOCAP_BATCH_ATOMIC;
		// return 0;
	}
}

export default class Opfs extends Vfs {
	name = 'opfs';
	async open(filename, flags) {
		// console.log(filename, 'open', flags);
		const create = flags & SQLITE_OPEN_CREATE;
		const handle = await dir.getFileHandle(filename, { create });
		return new OpfsFile(handle, flags);
	}
	async delete(filename, sync) {
		// console.log(filename, 'delete', sync);
		await dir.removeEntry(filename);
	}
	async access(filename, flags) {
		// console.log(filename, 'access', flags);
		if (flags == SQLITE_ACCESS_EXISTS) {
			try {
				await dir.getFileHandle(filename);
				return true;
			} catch {
				return false;
			}
		}
		throw new Error();
	}
}
