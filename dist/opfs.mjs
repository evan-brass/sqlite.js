import {
	SQLITE_OK,
	SQLITE_ACCESS_EXISTS,
	SQLITE_FCNTL_BEGIN_ATOMIC_WRITE, SQLITE_FCNTL_COMMIT_ATOMIC_WRITE, SQLITE_FCNTL_ROLLBACK_ATOMIC_WRITE,
	SQLITE_IOCAP_ATOMIC, SQLITE_IOCAP_BATCH_ATOMIC,
	SQLITE_OPEN_CREATE, SQLITE_OPEN_DELETEONCLOSE, SQLITE_NOTFOUND
} from './sqlite_def.mjs';

// TODO: Support openning files in subfolders of the OPFS
// TODO: Re-write this whole file... it's pretty bad.

export class OpfsFile {
	#handle;
	#lock;
	#writable = false;
	flags = 0;
	sector_size = 0;
	constructor(handle, _flags) {
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
	async sync() {
		if (this.#writable) {
			await this.#writable.close();
			this.#writable = false;
		}
	}
	async read(offset, len) {
		// console.log(this.#handle.name, 'read', len, 'at', offset);
		offset = Number(offset);
		if (this.#writable) throw new Error('wat');
		const file = await this.#handle.getFile();
		const section = file.slice(offset, offset + len);
		const data = new Uint8Array(await section.arrayBuffer());
		// console.log(data);
		return data;
	}
	async write(buffer, offset) {
		// console.log(this.#handle.name, 'write', buffer.byteLength, 'at', offset);
		// console.log(buffer.slice());
		let close_immediate = false;
		if (!this.#writable) {
			this.#writable = await this.#handle.createWritable({keepExistingData: true});
			close_immediate = true;
		}
		await this.#writable.write({ type: 'write', data: buffer, position: Number(offset) });
		if (close_immediate) {
			await this.#writable.close();
			this.#writable = false;
		}
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
			return SQLITE_NOTFOUND;
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
		// TODO: implement the double locks to properly support reserved locking.
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
		if (lock_level == 0 && this.#lock) {
			this.#lock.release();
			this.#lock = false;
		}
	}
	check_reserved_lock() {
		// TODO:
		return 1;
		throw new Error();
	}
	sector_size() { return 1; }
	device_characteristics() {
		// console.log(this.#handle.name, 'iocap');
		return SQLITE_IOCAP_ATOMIC | SQLITE_IOCAP_BATCH_ATOMIC;
	}
}

export class Opfs {
	name = 'opfs';
	max_pathname = 64;
	async open(filename, flags) {
		// console.log(filename, 'open', flags);
		const create = flags & SQLITE_OPEN_CREATE;
		const dir = await navigator.storage.getDirectory();
		const handle = await dir.getFileHandle(filename, { create });
		return new OpfsFile(handle, flags);
	}
	async delete(filename, sync) {
		// console.log(filename, 'delete', sync);
		const dir = await navigator.storage.getDirectory();
		await dir.removeEntry(filename);
	}
	async access(filename, flags) {
		// console.log(filename, 'access', flags);
		if (flags == SQLITE_ACCESS_EXISTS) {
			try {
				const dir = await navigator.storage.getDirectory();
				await dir.getFileHandle(filename);
				return true;
			} catch {
				return false;
			}
		}
		throw new Error();
	}
	full_pathname(pathname) { return pathname; }
}
export default new Opfs();
