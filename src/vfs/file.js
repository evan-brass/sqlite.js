import {
	SQLITE_OK, SQLITE_NOTFOUND,
	SQLITE_OPEN_DELETEONCLOSE,
	SQLITE_IOCAP_ATOMIC, SQLITE_IOCAP_BATCH_ATOMIC,
	SQLITE_FCNTL_BEGIN_ATOMIC_WRITE, SQLITE_FCNTL_COMMIT_ATOMIC_WRITE, SQLITE_FCNTL_ROLLBACK_ATOMIC_WRITE,
	SQLITE_IOCAP_POWERSAFE_OVERWRITE, SQLITE_IOCAP_SAFE_APPEND,
} from '../dist/sqlite_def.js';


function get_lock(name, options = {mode: 'shared'}) {
	return new Promise(res => {
		navigator.locks.request(name, options, async lock => {
			res(lock);
			if (lock) {
				await new Promise(res2 => { lock.release = res2; })
			}
		});
	});
}
function res_name(lock_name) {
	return lock_name + '-r';
}

export class File {
	#handle;
	
	flags;
	sector_size = 0;
	
	#lock_name;
	#lock;
	#res_lock;

	#blob;
	#size;
	#atomic = false;
	#writable;
	#dirty = new Set();

	constructor(handle, flags, lock_name = handle.name) {
		this.#handle = handle;
		this.flags = flags;
		this.#lock_name = lock_name;
	}
	get handle() {
		return this.#handle;
	}

	// Other:
	device_characteristics() {
		return SQLITE_IOCAP_POWERSAFE_OVERWRITE | SQLITE_IOCAP_SAFE_APPEND |
			SQLITE_IOCAP_ATOMIC | SQLITE_IOCAP_BATCH_ATOMIC;
	}
	// Locking:
	async lock(level) {
		if (level >= 1 && !this.#lock) {
			// Aquire a shared lock on lock_name
			this.#lock = await get_lock(this.#lock_name);

			this.#blob = await this.#handle.getFile();
			this.#size = this.#blob.size;
		}
		if (level >= 2 && !this.#res_lock) {
			// Aquire an exclusive lock on lock_name_res or return BUSY if it isn't available.
			this.#res_lock = await get_lock(res_name(this.#lock_name), {mode: 'exclusive', ifAvailable: true});
			if (!this.#res_lock) return false;
		}
		if (level >= 3 && this.#lock.mode == 'shared') {
			// Exchange our shared lock on lock_name for an exclusive lock on lock_name
			const new_lock_prom = get_lock(this.#lock_name, {mode: 'exclusive'});
			this.#lock.release();
			this.#lock = await new_lock_prom;
		}
		// We don't need to do anything for level 4 (EXCLUSIVE) because we do all that work inside pending.

		return true;
	}
	async unlock(level) {
		if (level <= 1 && this.#lock?.mode == 'exclusive') {
			const prom = get_lock(this.#lock_name);
			this.#lock.release();
			this.#lock = await prom;
			this.#res_lock.release();
			this.#res_lock = null;
		}
		if (level <= 0 && this.#lock) {
			this.#lock.release();
			this.#lock = null;
		}
	}
	async check_reserved_lock() {
		const {held} = await navigator.locks.query(res_name(this.#lock_name));
		return Boolean(held.length);
	}
	// IO:
	async close() {
		if (this.flags & SQLITE_OPEN_DELETEONCLOSE) {
			await this.#handle.remove();
		}
	}
	sync() {
		// Don't sync when in the middle of atomic write:
		if (this.#atomic) return;

		if (this.#writable) return (async () => {
			// Close the writable stream:
			await this.#writable.close();
			this.#writable = null;
			// Clear the dirty set:
			this.#dirty.clear();
			// Clear the File blob handle:
			this.#blob = null;
		})();
	}
	async read(offset, len) {
		offset = Number(offset);
		console.assert(this.#atomic === false, "We can't read in the middle of an atomic write.");

		// If the offset is dirty, then we need to sync the file before reading:
		if (this.#dirty.has(offset)) await this.sync();
		
		this.#blob ??= await this.#handle.getFile();

		const section = this.#blob.slice(offset, offset + len);
		return new Uint8Array(await section.arrayBuffer());
	}
	async write(buffer, offset) {
		offset = Number(offset);
		this.#writable ??= await this.#handle.createWritable({keepExistingData: true});

		await this.#writable.seek(Number(offset));
		await this.#writable.write(buffer);
		// TODO: If there's more than 100 dirty pages then just mark the whole file as dirty?
		this.#dirty.add(offset);

		// Update the file size:
		this.#size = Math.max(this.#size, offset + buffer.byteLength);
	}
	file_control(op, _arg) {
		if (op == SQLITE_FCNTL_BEGIN_ATOMIC_WRITE) {
			this.#atomic = true;
			return SQLITE_OK;
		}
		else if (op == SQLITE_FCNTL_ROLLBACK_ATOMIC_WRITE) {
			return (async () => {
				await this.#writable.abort();
				this.#atomic = false;
				this.#writable = null;
				this.#dirty.clear();
				// Update the file size:
				this.#blob = await this.#handle.getFile();
				this.#size = this.#blob.size;
				return SQLITE_OK;
			})();
		}
		else if (op == SQLITE_FCNTL_COMMIT_ATOMIC_WRITE) {
			return (async () => {
				await this.#writable.close();
				this.#atomic = false;
				this.#writable = null;
				this.#dirty.clear();
				return SQLITE_OK;
			})();
		}
		else {
			return SQLITE_NOTFOUND;
		}
	}
	async trunc(length) {
		length = Number(length);
		this.#writable ??= await this.#handle.createWritable({keepExistingData: true});
		await this.#writable.truncate(length);

		// Remove any dirty pages that are past the new length:
		for (const offset of this.#dirty) {
			if (offset > length) this.#dirty.delete(offset);
		}

		// Update the file size:
		this.#size = length;
	}
	size() {
		return BigInt(this.#size);
	}
}
