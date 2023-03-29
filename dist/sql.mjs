import { SQLITE_DONE, SQLITE_OK, SQLITE_OPEN_CREATE, SQLITE_OPEN_EXRESCODE, SQLITE_OPEN_READWRITE, SQLITE_ROW } from "./sqlite_def.mjs";
import spawn_in_worker from "./vm.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const vfs_impls = new Map();
const file_impls = new Map();
const file_parent = new WeakMap();
export const sqlite3 = await spawn_in_worker(fetch(new URL('sqlite3.wasm', import.meta.url)), {
	env: {
		logging(_, code, ptr) {
			console.log(code, ptr);
		},
		async sqlite3_os_init() {
			await sqlite3.set_logging();
			const name_ptr = alloc_str('mem');
			const vfs_ptr = await sqlite3.allocate_vfs(name_ptr);
			const res = await sqlite3.sqlite3_vfs_register(vfs_ptr, 0);

			return res;
		},
		async sqlite3_os_end() {
			return SQLITE_OK;
		}
	}, vfs: {
		async xOpen(vfs_ptr, name_ptr, file_ptr, flags, flags_out_ptr) { debugger; },
		async xDelete(vfs_ptr, name_ptr, sync) { debugger; },
		async xAccess(vfs_ptr, name_ptr, flags, result_ptr) { debugger; },
		async xFullPathname(vfs_ptr, name_ptr, out_len, out_ptr) { debugger; },
		xRandomness(vfs_ptr, out_len, out_ptr) { debugger; },
		async xSleep(vfs_ptr, microseconds) { debugger; },
		xGetLastError(vfs_ptr, out_len, out_ptr) { debugger; },
		xCurrentTimeInt64(vfs_ptr, out_ptr) { debugger; }
	}
});

async function alloc_str(s) {
	if (!s.endsWith('\0')) {
		s += '\0';
	}
	const encoded = encoder.encode(s);
	const ptr = await sqlite3.malloc(encoded.byteLength);
	if (!ptr) return;
	await sqlite3.memory.write(ptr, encoded);
	return ptr;
}
async function read_str(ptr) {
	const len = await sqlite3.memory.cstr_len(ptr);
	let ret = '';
	if (len > 0) {
		const buff = await sqlite3.memory.read(ptr, len);
		ret = decoder.decode(buff);
	}
	return ret;
}

async function handle_error(code, conn) {
	if (code == SQLITE_OK || code == SQLITE_ROW || code == SQLITE_DONE) return;
	let ptr;
	if (conn) {
		ptr = await sqlite3.sqlite3_errmsg(conn);
	} else {
		ptr = await sqlite3.sqlite3_errstr(code);
	}
	const msg = await read_str(ptr);
	throw new Error(`SQLite Error(${code}): ${msg}`);
}

export default async function connect(pathname, flags = SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_EXRESCODE) {
	let pathname_ptr, conn_ptr;
	try {
		pathname_ptr = await alloc_str(pathname);
		conn_ptr = await sqlite3.malloc(4);
		if (!pathname_ptr || !conn_ptr) return;
		const res = await sqlite3.sqlite3_open_v2(pathname_ptr, conn_ptr, flags, 0);
		const conn = await sqlite3.memory.read_i32(conn_ptr);
		handle_error(res);
	
		return conn;
	} catch(e) {
		await sqlite3.sqlite3_close_v2(conn);
		throw e;
	} finally {
		await sqlite3.free(pathname_ptr);
		await sqlite3.free(conn_ptr);
	}
}
