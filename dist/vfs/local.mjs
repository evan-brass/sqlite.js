// Temporary Dependency on idb because working with IndexedDB sucks
import { openDB } from 'https://unpkg.com/idb?module';
import {
	SQLITE_OPEN_CREATE,
	SQLITE_ACCESS_EXISTS,
	SQLITE_ACCESS_READWRITE
} from "sql.mjs/sqlite_def.mjs";
import { File } from "./file.mjs";

// A VFS to unify everything with a FileSystemHandle (Which is everything local to this computer):
//  - The Origin Private File System
//  - FileSystemFileHandle's aquired through showFilePicker() or drag-and-drop
//  - FileSystemDirectoryHandle's aquired through showDirectoryPicker or drag-and-drop
//  - Traversing into sub-handles through those FileSystemDirectoryHandles

export class Local {
	name = 'local';
	max_pathname = 255;
	#db;
	constructor(idb_name = 'sql.mjs') {
		this.#db = openDB(idb_name, 1, {
			upgrade(db, _oldVersion, _newVersion, _transaction) {
				db.createObjectStore('handles');
			}
		});
	}
	async traverse(pathname, flags = 0) {
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
		const handle = await this.traverse(pathname, flags);
		if (!handle) throw new Error("That file isn't in the Local VFS's database.");
		return new File(pathname, handle, flags);
	}
	async delete(pathname, _flags) {
		const handle = await this.traverse(pathname);
		if (handle) await handle.remove();
	}
	async access(pathname, mode) {
		const handle = await this.traverse(pathname);
		if (mode == SQLITE_ACCESS_EXISTS) return Boolean(handle);
		if (mode == SQLITE_ACCESS_READWRITE) {
			const perm = handle.queryPermission('readwrite');
			return perm == 'granted';
		}
		throw new Error('not implemented');
	}
}
export default new Local();
