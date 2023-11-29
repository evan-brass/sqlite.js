import {
	SQLITE_OPEN_READONLY,
	SQLITE_NOTFOUND,
	SQLITE_IOCAP_IMMUTABLE,
} from '../sqlite_def.js';

// Example DB: https://phiresky.github.io/world-development-indicators-sqlite/split-db/db.sqlite3.000

function check_err(resp) {
	if (resp.ok) return;
	throw new Error(`HTTP VFS:(${resp.status}) ${resp.statusText}`)
}

class BlobFile {
	#inner;
	flags;
	sector_size = 0;
	constructor(blob, flags) {
		this.#inner = blob;
		this.flags = flags;
	}
	// IO:
	device_characteristics() { return SQLITE_IOCAP_IMMUTABLE; }
	async read(offset, len) {
		offset = Number(offset);
		return new Uint8Array(await this.#inner.slice(offset, offset + len).arrayBuffer());
	}
	size() { return this.#inner.size; }
	close() {}
	file_control(_op, _arg) { return SQLITE_NOTFOUND; }
}
class HttpFile {
	#url;
	#size = false;
	flags;
	constructor(response, flags) {
		this.flags = flags;
		this.#url = response.url;
	}
	sector_size = 0;
	// IO:
	device_characteristics() { return SQLITE_IOCAP_IMMUTABLE; }
	async read(offset, len) {
		// Gosh, I really wish Math.min worked with BigInts.
		let end = offset + BigInt(len);
		end -= 1n; // Byte ranges are inclusive for some reason...
		const resp = await fetch(this.#url, { headers: {
			'Range': `bytes=${offset}-${end}`
		} });
		check_err(resp);
		if (resp.status !== 206) throw new Error("Received a non-partial response.");

		return new Uint8Array(await resp.arrayBuffer());
	}
	size() {
		if (this.#size !== false) return this.#size;
		return (async () => {
			const resp = await fetch(this.#url, {method: 'head'});
			check_err(resp);
			this.#size = BigInt(resp.headers.get('Content-Length'));
			return this.#size;
		})();
	}
	close() {}
	file_control(_op, _arg) { return SQLITE_NOTFOUND; }
}

export class Http {
	name = 'http';
	max_pathname = 255;
	async open(filename, flags) {
		flags &= SQLITE_OPEN_READONLY;
		const url = new URL(String(filename));
		url.protocol = filename.get_parameter('proto', url.protocol);

		// Fetch the db.  Follow redirects, and determine if range queries are supported.
		const resp = await fetch(url, {headers: {'Range': 'bytes=0-99'}});
		check_err(resp);

		// Check if the server supported our range request (returned partial content)
		if (resp.status == 206) {
			return new HttpFile(resp, flags);
		} else {
			return new BlobFile(await resp.blob(), flags);
		}
	}
	delete(_filename, _sync) { throw new Error('Unimplementable'); }
	access(_filename, _flags) { return false; }
	full_pathname(pathname) {
		const url = new URL(pathname, location);
		return String(url);
	}
}
export default new Http();
