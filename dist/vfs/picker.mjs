import {
	SQLITE_OPEN_DELETEONCLOSE,
	SQLITE_OPEN_READONLY,
	SQLITE_OPEN_READWRITE
} from '../sqlite_def.mjs';
import { File } from './file.mjs';
import {default as opfs} from './opfs.mjs';

// TODO: Complete rewrite, this is all shit.
export const handles = new Map(); // key (string) -> FileSystemFileHandle

const accept = {'application/sqlite*': ['.sqlite', '.sqlite3', '.db', '.db3']};

export class Picker {
	name = 'picker';
	max_pathname = 64;
	flags_filter = SQLITE_OPEN_READONLY | SQLITE_OPEN_READWRITE | SQLITE_OPEN_DELETEONCLOSE;
	async open(filename, flags) {
		if (String(filename).endsWith('.tmp')) {
			// pass temp files to the opfs filesystem:
			return await opfs.open(...arguments);
		}

		let [command, rest] = String(filename).split(':');
		command = command.toLocaleLowerCase();
		let handle;
		if (command == 'save') {
			const suggestedName = rest;
			handle = await showSaveFilePicker({
				suggestedName,
				types: [{ description: 'SQLite Database', accept }]
			});
		}
		else if (command == 'filehandle') {
			handle = handles.get(rest);
		}
		else {
			const description = rest;
			[handle] = await showOpenFilePicker({
				multiple: false,
				types: [{ description, accept }]
			});
		}

		// TODO: Shift permission request from read to open
		return new File(handle, flags);
	}
	async delete(_filename, _sync) {
		throw new Error("Not implemented.");
	}
	async access(_filename, _flags) {
		return false;
	}
	async full_pathname(pathname) { return pathname }
}
export default new Picker();
