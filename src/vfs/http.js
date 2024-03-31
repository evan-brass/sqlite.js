import {
	SQLITE_OPEN_READONLY,
	SQLITE_NOTFOUND,
	SQLITE_IOCAP_IMMUTABLE,
} from '../dist/sqlite_def.js';

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
		const size = /\/([0-9]+)$/.exec(response.headers.get('Content-Range'))?.[1] ?? response.headers.get('Content-Length');
		this.#size = BigInt(size);
		response.body.cancel();
	}
	sector_size = 0;
	// IO:
	device_characteristics() { return SQLITE_IOCAP_IMMUTABLE; }
	async read(offset, len) {
		// Gosh, I really wish Math.min worked with BigInts.
		let end = offset + BigInt(len);
		end -= 1n; // Byte ranges are inclusive for some reason...
		const headers = new Headers();
		headers.set('Range', `bytes=${offset}-${end}`);
		const resp = await fetch(this.#url, { headers, cache: 'force-cache', redirect: 'error' });
		check_err(resp);
		if (resp.status !== 206) throw new Error("Received a non-partial response.");

		return new Uint8Array(await resp.arrayBuffer());
	}
	size() {
		return this.#size;
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
		let resp = await fetch(url, {headers: {'Range': 'bytes=0-99'}, cache: 'reload', redirect: 'follow'});
		check_err(resp);
		
		if (resp.status != 206) {
			return new BlobFile(await resp.blob(), flags);
		}

		// Check if the server supports Content-Range.  If not then pull the file size from the Content-Length of a HEAD request
		// (This usually happens if a server doesn't Access-Control-Expose-Header the Content-Range)
		if (!resp.headers.has('Content-Range')) {
			resp = await fetch(resp.url, {method: 'HEAD', cache: 'reload'});
			check_err(resp);
		}
		return new HttpFile(resp, flags);
	}
	delete(_filename, _sync) { throw new Error('Unimplementable'); }
	access(_filename, _flags) { return false; }
	full_pathname(pathname) {
		const url = new URL(pathname, location ?? 'http://localhost');
		return String(url);
	}
}

const instance = new Http();
export default instance;

const options = new URL(import.meta.url).searchParams;
if (options.has('register')) {
	const { register_vfs } = await import('./custom.js');
	await register_vfs(instance, options.has('default'));
}
