import { SQLITE_OK, SQLITE_OPEN_CREATE, SQLITE_OPEN_EXRESCODE, SQLITE_OPEN_READWRITE } from "./sqlite_def.mjs";
import spawn_in_worker from "./vm.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const sqlite3 = await spawn_in_worker(fetch(new URL('sqlite3.wasm', import.meta.url)), {
	env: {
		logging(_, code, ptr) {
			console.log(code, ptr);
		},
		async sqlite3_os_init() {
			await sqlite3.set_logging();
			const name_ptr = alloc_str('mem');
			const vfs_ptr = await sqlite3.allocate_vfs()

			return SQLITE_OK;
		},
		async sqlite3_os_end() {
			return SQLITE_OK;
		}
	}, vfs: {
		async xOpen() { debugger; },
		async xAccess() { debugger; },
		async xDelete() { debugger; },
		xCurrentTimeInt64() { debugger; }
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

export default async function connect(pathname, flags = SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_EXRESCODE) {
	const pathname_ptr = alloc_str(pathname);
	if (!pathname_ptr) return;
	const conn_ptr = await sqlite3.malloc(4);
	if (!conn_ptr) {
		await sqlite3.free(pathname_ptr);
		return;
	}
	await sqlite3.memory.write(pathname_ptr, encoded);
	const res = await sqlite3.sqlite3_open_v2(pathname_ptr, conn_ptr, flags, 0);

	if (res != 0) return;
	debugger;
}
