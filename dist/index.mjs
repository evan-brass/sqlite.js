import { default as sqlite_initialized, sqlite3 } from './sqlite.mjs';
import * as vfs from './vfs/index.mjs';

export * as sqlite_def from './sqlite_def.mjs';

export * from './asyncify.mjs';
export * from './func.mjs';
export * from './conn.mjs';
export * from './blob.mjs';
export * from './pool.mjs';
export * from './value.mjs';
export {sqlite3, vfs};

export const initialized = (async () => {
	await sqlite_initialized;

	vfs.register_vfs(vfs.opfs, true);
	vfs.register_vfs(vfs.picker);
	vfs.register_vfs(vfs.http);
})();
