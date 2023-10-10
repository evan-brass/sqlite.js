// Temporary Dependency on idb because working with IndexedDB sucks
import { openDB } from 'https://unpkg.com/idb?module';
import { SQLITE_NOTFOUND, SQLITE_OPEN_CREATE, SQLITE_OPEN_DELETEONCLOSE } from "sql.mjs/sqlite_def.mjs";

// A VFS to unify everything with a FileSystemHandle (Which is everything local to this computer):
//  - The Origin Private File System
//  - FileSystemFileHandle's aquired through showFilePicker() or drag-and-drop
//  - FileSystemDirectoryHandle's aquired through showDirectoryPicker or drag-and-drop
//  - Traversing into sub-handles through those FileSystemDirectoryHandles

export class File {
	pathname;
	#db;
	#handle;
	flags;
	
	#lock_level = 0;
	#blob;
	#writable;
	
	device_characteristics() { return 0; }
	constructor(pathname, handle, flags, db) {
		this.pathname = String(pathname);
		this.#handle = handle;
		this.flags = flags;
		this.#db = db;
	}

	close() {
		if (this.flags & SQLITE_OPEN_DELETEONCLOSE) return this.#handle.remove();
	}
	async read(offset, len) {
		// TODO: Handle permissions
		// TODO: sync access
		offset = Number(offset);
		if (!this.#blob) this.#blob = await this.#handle.getFile();
		return await this.#blob.slice(offset, offset + len);
	}
	async write(buff, offset) { debugger; }
	async trunc(size) { debugger; }
	async sync(flags) { debugger; }
	async size() {
		if (!this.#blob) this.#blob = await this.#handle.getFile();
		return this.#blob.size;
	}
	async lock(lock_level) {
		if (this.#lock_level >= lock_level) return true;

		const trans = await this.#db.transaction('locks', 'readwrite');
		const locks = await trans.store.get(this.pathname) ?? { read: 0, write: false };

		// Unlocked(0) -> Shared(1)
		if (this.#lock_level < 1 && lock_level >= 1) {
			if (locks.write == 'exclusive') return false;
			locks.read += 1;
		}

		// Shared(1) -> Reserved(2)
		if (this.#lock_level < 2 && lock_level >= 2) {
			if (locks.write) return false;
			locks.write = 'reserved';
		}

		// Reserved(2) -> Pending(3)
		if (this.#lock_level < 3 && lock_level >= 3) {
			locks.write = 'exclusive';
		}

		// Pending(3) -> Exclusive(4)
		if (this.#lock_level < 4 && lock_level >= 4) {
			if (locks.read > 0) return false;
		}

		await trans.store.put(locks, this.pathname);

		// Locking was successful:
		this.#lock_level = lock_level;
		return true;
	}
	async unlock(lock_level) {
		if (this.#lock_level <= lock_level) return;
		debugger;
	}
	async check_reserved_lock() {
		const locks = await this.#db.get('locks', this.pathname) ?? { read: 0, write: false };
		return Boolean(locks.write);
	}
	file_control(_op, _arg) { return SQLITE_NOTFOUND; }
}

export class Local {
	name = 'local';
	max_pathname = 255;
	#db;
	constructor(idb_name = 'sql.mjs') {
		this.#db = openDB(idb_name, 1, {
			upgrade(db, _oldVersion, _newVersion, _transaction) {
				db.createObjectStore('handles');
				db.createObjectStore('locks');
			}
		});
	}
	async traverse(pathname, flags) {
		// TODO: Access any parameters before converting pathname to a String?
		pathname = String(pathname);
		if (!pathname.startsWith('/')) pathname = '/' + pathname;

		const db = await this.#db;
		const trans = await db.transaction('handles');
		const create = Boolean(flags & SQLITE_OPEN_CREATE);

		// Find the best matching directory handle (or exact matching file handle):
		let cursor = await trans.store.openCursor(IDBKeyRange.upperBound(pathname));
		let path, handle;
		while (cursor) {
			// If the handle is a filehandle then the pathname must match exactly:
			if (cursor.value.kind == 'file') {
				if (pathname === `${cursor.key}/${cursor.value.name}`) return cursor.value;
			}
			// For directory handles, we require that the pathname starts with the key:
			else if (pathname.startsWith(cursor.key)) {
				const path_i = pathname.substring(cursor.key.length).split('/');

				if (!handle || path.length > path_i.length) {
					path = path_i;
					handle = cursor.value;
				}
			}

			cursor = await cursor.continue();
		}

		// Traverse down the directory handle until we find (or create) the file:
		while (handle && path.length) {
			const name = path.shift();
			handle = await handle[path.length ? 'getDirectoryHandle' : 'getFileHandle'](name, {create});
		}
		if (handle?.kind == 'file') return handle;
	}
	async mount(handle, path) {
		if (!path.endsWith('/')) path += '/';
		const db = await this.#db;
		await db.put('handles', handle, path);
	}
	// VFS methods:
	full_pathname(s) { return s; }
	async open(pathname, flags) {
		const db = await this.#db;
		const handle = await this.traverse(pathname, flags);
		if (!handle) throw new Error("That file isn't in the Local VFS's database.");
		return new File(pathname, handle, flags, db);
	}
	async delete(pathname, flags) {

	}
	async access(pathname, mode) {

	}
}
export default new Local();
