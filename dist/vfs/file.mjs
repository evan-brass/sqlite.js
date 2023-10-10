import {
	SQLITE_OK,
	SQLITE_FCNTL_BEGIN_ATOMIC_WRITE, SQLITE_FCNTL_COMMIT_ATOMIC_WRITE, SQLITE_FCNTL_ROLLBACK_ATOMIC_WRITE,
	SQLITE_IOCAP_ATOMIC, SQLITE_IOCAP_BATCH_ATOMIC,
	SQLITE_OPEN_DELETEONCLOSE, SQLITE_NOTFOUND
} from '../sqlite_def.mjs';


function get_lock(name, options) {
	return new Promise(res => {
		navigator.locks.request(name, options, async lock => {
			res(lock);
			if (lock) {
				await new Promise(res2 => { lock.release = res2; })
			}
		});
	});
}

export class File {
	flags;
	#handle;
	#lock;
	#res_lock;
	#writable_stream;
	sector_size = 0;
	constructor(handle, flags) {
		this.#handle = handle;
		this.flags = flags;
	}
	get handle() {
		return this.#handle;
	}

	// Other:
	device_characteristics() {
		return SQLITE_IOCAP_ATOMIC | SQLITE_IOCAP_BATCH_ATOMIC;
	}
	// Locking:
	get lock_name() {
		return `opfs.mjs:${this.#handle.name}`;
	}
	get lock_name_res() {
		return this.lock_name + '-r';
	}
	async lock(level) {
		if (level >= 1 && !this.#lock) {
			// Aquire a shared lock on lock_name
			this.#lock = await get_lock(this.lock_name, {mode: 'shared', ifAvailable: true});
			if (!this.#lock) return false;
		}
		if (level >= 2 && !this.#res_lock) {
			// Aquire an exclusive lock on lock_name_res or return BUSY if it isn't available.
			this.#res_lock = await get_lock(this.lock_name_res, {mode: 'exclusive', ifAvailable: true});
			if (!this.#res_lock) return false;
		}
		if (level >= 3 && !this.#lock.mode == 'shared') {
			// Exchange our shared lock on lock_name for an exclusive lock on lock_name
			const new_lock_prom = get_lock(this.lock_name);
			this.#lock.release();
			this.#lock = await new_lock_prom;
		}
		// We don't need to do anything for level 4 (EXCLUSIVE) because we do all that work inside pending.

		return true;
	}
	async unlock(level) {
		if (level <= 1 && this.#lock?.mode == 'exclusive') {
			this.#lock.release();
			this.#lock = await get_lock(this.lock_name, {mode: 'shared'});
			this.#res_lock.release();
			this.#res_lock = null;
		}
		if (level <= 0 && this.#lock) {
			this.#lock.release();
			this.#lock = null;
		}
	}
	async check_reserved_lock() {
		const res = await get_lock(this.lock_name_res, {mode: 'shared', ifAvailable: true});
		if (res) {
			res.release();
		}
		return !res;
	}
	// IO:
	async close() {
		if (this.flags & SQLITE_OPEN_DELETEONCLOSE) {
			await this.#handle.remove();
		}
	}
	async sync() {
		if (this.#writable_stream) throw new Error('wat?');
	}
	async read(offset, len) {
		if (this.#handle.requestPermission) {
			const res = await this.#handle.requestPermission({mode: 'read'});
			if (res != 'granted') throw new Error("Permission denied");
		}
		offset = Number(offset);
		if (this.#writable_stream) throw new Error('wat?');
		const file = await this.#handle.getFile();
		const section = file.slice(offset, offset + len);
		const data = new Uint8Array(await section.arrayBuffer());
		return data;
	}
	async write(buffer, offset) {
		if (this.#handle.requestPermission) {
			const res = await this.#handle.requestPermission({mode: 'readwrite'});
			if (res != 'granted') throw new Error("Permission denied");
		}
		const position = Number(offset);
		const stream = this.#writable_stream ?? await this.#handle.createWritable({keepExistingData: true});

		await stream.write({type: 'write', data: buffer, position});

		if (this.#writable_stream != stream) await stream.close();
	}
	async file_control(op, _arg) {
		if (op == SQLITE_FCNTL_BEGIN_ATOMIC_WRITE) {
			this.#writable_stream = await this.#handle.createWritable({keepExistingData: true});
			return SQLITE_OK;
		}
		else if (op == SQLITE_FCNTL_COMMIT_ATOMIC_WRITE) {
			await this.#writable_stream.close();
			this.#writable_stream = null;
			return SQLITE_OK;
		}
		else if (op == SQLITE_FCNTL_ROLLBACK_ATOMIC_WRITE) {
			await this.#writable_stream.abort();
			this.#writable_stream = null;
			return SQLITE_OK;
		} else {
			return SQLITE_NOTFOUND;
		}
	}
	async trunc(length) {
		if (this.#writable_stream) throw new Error('wat?');
		const writable = await this.#handle.createWritable({keepExistingData: true});
		await writable.truncate(Number(length));
		await writable.close();
	}
	async size() {
		const file = await this.#handle.getFile();
		return BigInt(file.size);
	}
}
