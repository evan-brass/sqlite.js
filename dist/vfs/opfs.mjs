import {
	SQLITE_ACCESS_EXISTS,
	SQLITE_OPEN_CREATE
} from '../sqlite_def.mjs';
import { File } from './file.mjs';

async function descend(filename, flags) {
	if (String(filename).startsWith('//')) throw new Error("The origin private file system doesn't support files with custom authorities.");
	let handle = await navigator.storage.getDirectory();
	const create = Boolean(flags & SQLITE_OPEN_CREATE);
	const path = String(filename).split('/');
	while (path.length) {
		const part = path.shift();
		if (!part) continue;
		
		handle = await handle[`get${path.length ? 'Directory' : 'File'}Handle`](part, { create });
	}
	if (!(handle instanceof FileSystemFileHandle)) throw new Error('Bad path.');
	return handle;
}

export class Opfs {
	name = 'opfs';
	max_pathname = 128;
	async open(filename, flags) {
		const handle = await descend(filename, flags);
		return new File(handle, flags);
	}
	async delete(filename, sync) {
		const handle = await descend(filename, 0);
		await handle.remove();
	}
	async access(filename, flags) {
		// console.log(filename, 'access', flags);
		if (flags == SQLITE_ACCESS_EXISTS) {
			try {
				const _handle = await descend(filename, 0);
				return true;
			} catch {
				return false;
			}
		}
		throw new Error("Unimplemented");
	}
	full_pathname(pathname) { return pathname; }
}
export default new Opfs();
