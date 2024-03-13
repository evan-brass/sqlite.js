/**
 * basics.js - Adds implementations for randomness, sleep, and current time.
 * You'll need this file if you want to use date or time sql functions,
 * random sql functions, or sqlite3_busy_timeout.
 * If you don't need these functions then you don't need to import this file.
 */
import { imports, mem8, memdv } from "../sqlite.js";
import { SQLITE_OK } from "../dist/sqlite_def.js";

// These implementations do not consult custom VFSs.  I don't know why you would need to override these implementations inside a custom VFS, but if you do - let me know.
imports['vfs'] ??= {};
Object.assign(imports['vfs'], {
	xRandomness(_vfs, buff_len, buff_ptr) {
		crypto.getRandomValues(mem8(buff_ptr, buff_len));
		return buff_len;
	},
	async xSleep(_vfs, microseconds) {
		await new Promise(res => setTimeout(res, microseconds / 1000));
	},
	xCurrentTimeInt64(_vfs, out_ptr) {
		const current_time = BigInt(Date.now()) + 210866760000000n;
		memdv().setBigInt64(out_ptr, current_time, true);
		return SQLITE_OK;
	}
});
