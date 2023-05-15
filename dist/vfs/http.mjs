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
	constructor(url, headers = {}) {
		this.url = url;
		this.headers = headers;
	}
	// IO:
	device_characteristics() { return SQLITE_IOCAP_IMMUTABLE; }
	async read(offset, len) {
		const headers = Object.create(this.headers);
		headers['Range'] = `bytes=${offset}-${offset + BigInt(len - 1)}`;
		const resp = await fetch(this.url, { headers });
		if (!resp.ok) throw new Error(`HTTP VFS Error (${resp.status}): ${resp.statusText}`);

		return new Uint8Array(await resp.arrayBuffer());
	}
	async size() {
		const headers = Object.create(this.headers);
		const resp = await fetch(this.url, {
			method: 'head',
			headers
		});
		if (!resp.ok) throw new Error(`HTTP VFS Error (${resp.status}): ${resp.statusText}`);

		return BigInt(resp.headers.get('content-length'));
	}
	async file_control(_op, _arg) { return SQLITE_NOTFOUND; }
}

export class Http {
	name = 'http';
	max_pathname = 128;
	async open(filename, flags) {
		const secure = filename.get_parameter('https', location?.protocol == 'https');
		filename = String(filename);
		const url = new URL(
			filename.startsWith('//') ? `${secure ? 'https' : 'http' }:${filename}` : filename,
			document?.baseURI ?? location
		);

		// Check if the file exists + get final URL + etag
		const resp = await fetch(url, {
			method: 'head',
		});
		if (!resp.ok) throw new Error(`HTTP VFS:(${resp.status}) ${resp.statusText}`);
		const headers = {};
		const etag = resp.headers.get('etag');
		if (etag) {
			headers['If-Match'] = etag;
		}
		const last_modified = resp.headers.get('last-modified');
		if (last_modified) {
			headers['If-Unmodified-Since'] = last_modified;
		}

		return new HttpFile(resp.url, headers);
	}
	async delete(filename, sync) { throw new Error('Unimplementable'); }
	async access(filename, flags) { debugger; return false; }
	full_pathname(pathname) { return pathname; }
}
export default new Http();
