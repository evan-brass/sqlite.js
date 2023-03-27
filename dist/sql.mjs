import { SQLITE_OK } from "./sqlite_def.mjs";
import instantiate from "./vm.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const sqlite3 = await instantiate(new URL('sql_worker.mjs', import.meta.url).href, new URL('sqlite3.wasm', import.meta.url).href, { env: {
	async sqlite3_os_init() {
		return SQLITE_OK;
	},
	async sqlite3_os_end() {
		return SQLITE_OK;
	}
}});

export default async function connect(pathname, flags) {
	if (!pathname.endsWith('\0')) pathname += '\0';
	const encoded = encoder.encode(pathname);
	const ptr = await sqlite3.sqlite3_malloc(encoded.byteLength);
	if (!ptr) return;
}
