import {
	SQLITE_OK,
	SQLITE_ACCESS_EXISTS,
	SQLITE_FCNTL_BEGIN_ATOMIC_WRITE, SQLITE_FCNTL_COMMIT_ATOMIC_WRITE, SQLITE_FCNTL_ROLLBACK_ATOMIC_WRITE,
	SQLITE_IOCAP_ATOMIC, SQLITE_IOCAP_BATCH_ATOMIC,
	SQLITE_OPEN_CREATE, SQLITE_OPEN_DELETEONCLOSE, SQLITE_OPEN_READONLY,
	SQLITE_NOTFOUND,
	SQLITE_IOCAP_IMMUTABLE
} from '../sqlite_def.mjs';

// Example DB: https://phiresky.github.io/world-development-indicators-sqlite/split-db/db.sqlite3.000

export class HttpFile {
	flags = SQLITE_OPEN_READONLY;
	url;
	headers;
	sector_size = 0;
	#size;
	constructor(url, size, headers = {}) {
		this.url = url;
		this.#size = size;
		this.headers = headers;
	}
	// IO:
	device_characteristics() { return SQLITE_IOCAP_IMMUTABLE; }
	async read(offset, len) {
		if (!this.#size) return new Uint8Array();
		const headers = Object.create(this.headers);
		// Gosh, I really wish Math.min worked with BigInts.
		let end = offset + BigInt(len);
		if (end > this.#size) end = this.#size;
		end -= 1n; // Byte ranges are inclusive for some reason...
		headers['Range'] = `bytes=${offset}-${end}`;
		const resp = await fetch(this.url, { headers });
		if (!resp.ok) throw new Error(`HTTP VFS Error (${resp.status}): ${resp.statusText}`);

		return new Uint8Array(await resp.arrayBuffer());
	}
	size() {
		return this.#size;
	}
	close() {}
	async file_control(_op, _arg) { return SQLITE_NOTFOUND; }
}

export class Http {
	name = 'http';
	max_pathname = 128;
	async open(filename, _flags) {
		const secure = filename.get_parameter('https', location?.protocol == 'https');
		filename = String(filename);
		let url;
		if (filename.startsWith('http')) {
			url = new URL(filename);
		} else if (filename.startsWith('//')) {
			url = new URL(`${secure ? 'https' : 'http'}:${filename}`);
		} else {
			url = new URL(filename, self?.document?.baseURI ?? location);
		}

		// Check if the file exists + get final URL + etag + size
		const resp = await fetch(url, {
			method: 'head',
		});
		if (!resp.ok) throw new Error(`HTTP VFS:(${resp.status}) ${resp.statusText}`);

		let size = resp.headers.get('content-length');
		if (!size) throw new Error('HTTP VFS: We require that the server return a content-length header in a HEAD response.');
		size = BigInt(size);
		
		const headers = {};
		const etag = resp.headers.get('etag');
		if (etag) {
			headers['If-Match'] = etag;
		}
		const last_modified = resp.headers.get('last-modified');
		if (last_modified) {
			headers['If-Unmodified-Since'] = last_modified;
		}

		return new HttpFile(resp.url, size, headers);
	}
	async delete(filename, sync) { throw new Error('Unimplementable'); }
	async access(filename, flags) { return false; }
	full_pathname(pathname) { return pathname; }
}
export default new Http();
