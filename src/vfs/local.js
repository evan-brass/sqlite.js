import {
	SQLITE_OPEN_CREATE,
	SQLITE_ACCESS_EXISTS,
	SQLITE_ACCESS_READWRITE
} from "../sqlite_def.js";
import { File } from "./file.js";
import { is_promise } from "../util.js";

// A VFS to unify everything with a FileSystemHandle (Which is everything local to this computer):
//  - The Origin Private File System
//  - FileSystemFileHandle's aquired through showFilePicker() or drag-and-drop
//  - FileSystemDirectoryHandle's aquired through showDirectoryPicker or drag-and-drop
//  - Traversing into sub-handles through those FileSystemDirectoryHandles
function on(target, handlers) {
	for (const key in handlers) {
		target.addEventListener(key, handlers[key]);
	}
}

export class Local {
	name = 'local';
	max_pathname = 255;
	#db;
	constructor(idb_name = 'sql.mjs') {
		this.#db = new Promise((res, rej) => {
			on(indexedDB.open(idb_name, 1), {
				upgradeneeded({ target: { result: db } }) {
					db.createObjectStore('handles');
				},
				success({ target: { result } }) { res(result); },
				error({ target: { error } }) { rej(error); }
			});
		});
	}
	async traverse(pathname, {flags = 0, dir_ok = false} = {}) {
		if (is_promise(this.#db)) this.#db = await this.#db;

		// TODO: Access any parameters before converting pathname to a String?
		pathname = String(pathname);
		if (!pathname.startsWith('/')) pathname = '/' + pathname;

		const trans = this.#db.transaction('handles');
		const create = Boolean(flags & SQLITE_OPEN_CREATE);

		// Find the best matching directory handle (or exact matching file handle):
		let path, handle;
		await new Promise((res, rej) => {
			// indexedDB is such an insanely gross API: if I had any other option for persisting opaque javascript objects (CryptoKeys, FileSystemHandles, RTCPeerCertificates, etc.) then I would gladly never touch it again.
			on(trans.objectStore('handles').openCursor(IDBKeyRange.upperBound(pathname)), {
				success({ target: { result: cursor }}) {
					if (!cursor) return res();

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

					cursor.continue();
				},
				error({ target: { error }}) { rej(error); }
			});
		});

		// Traverse down the directory handle until we find (or create) the file:
		while (handle && path.length) {
			const name = path.shift();
			try {
				handle = (await handle.getFileHandle(name, {create})) ?? (await handle.getDirectoryHandle(name, {create}));
			} catch {
				return;
			}
		}
		if (dir_ok || handle?.kind == 'file') return handle;
	}
	async mount(handle, path) {
		if (!path.startsWith('/')) path = '/' + path;
		if (!path.endsWith('/')) path += '/';
		
		if (is_promise(this.#db)) this.#db = await this.#db;
		const trans = this.#db.transaction('handles', 'readwrite');
		await new Promise((res, rej) => on(trans.objectStore('handles').put(handle, path), {
			success({ target: { result }}) { res(result); },
			error: rej
		}));
	}
	// VFS methods:
	full_pathname(s) { return s; }
	async open(pathname, flags) {
		const handle = await this.traverse(pathname, {flags});
		if (!handle) throw new Error("That file isn't in the Local VFS's database.");
		return new File(handle, flags, this.#db);
	}
	async delete(pathname, _flags) {
		const handle = await this.traverse(pathname);
		if (handle) await handle.remove();
	}
	async access(pathname, mode) {
		const handle = await this.traverse(pathname);
		if (!handle) return false;
		if (mode == SQLITE_ACCESS_EXISTS) return true;
		if (mode == SQLITE_ACCESS_READWRITE) {
			const perm = handle.queryPermission('readwrite');
			return perm == 'granted';
		}
		throw new Error('not implemented');
	}
}
export default new Local();
