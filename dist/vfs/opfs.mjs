import {
	SQLITE_ACCESS_EXISTS,
	SQLITE_OPEN_CREATE
} from '../sqlite_def.mjs';
import { File } from './file.mjs';

}

export class Opfs {
	name = 'opfs';
	max_pathname = 64;
	async open(filename, flags) {
		// TODO: Handle folders
		// console.log(filename, 'open', flags);
		const create = Boolean(flags & SQLITE_OPEN_CREATE);
		const dir = await navigator.storage.getDirectory();
		const handle = await dir.getFileHandle(filename, { create });
		return new File(handle, flags);
	}
	async delete(filename, sync) {
		// console.log(filename, 'delete', sync);
		const dir = await navigator.storage.getDirectory();
		await dir.removeEntry(filename);
	}
	async access(filename, flags) {
		// console.log(filename, 'access', flags);
		if (flags == SQLITE_ACCESS_EXISTS) {
			try {
				const dir = await navigator.storage.getDirectory();
				await dir.getFileHandle(filename);
				return true;
			} catch {
				return false;
			}
		}
		throw new Error();
	}
	full_pathname(pathname) { return pathname; }
}
export default new Opfs();
