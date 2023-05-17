import {
	SQLITE_ACCESS_EXISTS,
	SQLITE_OPEN_CREATE
} from '../sqlite_def.mjs';
import { File } from './file.mjs';
// TODO: Remove this dependency:
import { openDB } from 'https://unpkg.com/idb/build/index.js';

// TODO: Use an indexeddb database to store the previous file handles.
const db_prom = openDB('picker.mjs:filehandles', 1, {
	upgrade(db) {
		db.createObjectStore('handles', {autoIncrement: true});
	}
});


export class Picker {
	name = 'picker';
	max_pathname = 64;
	async open(filename, flags) {
		const db = await db_prom;

		const [command, rest] = String(filename).split(':');
		if (command != 'filehandle') throw new Error('yikes.');

		let [id, _] = rest.split('-');
		id = Number(id);

		const handle = await db.get('handles', id);
		return new File(handle, flags);
	}
	async delete(_filename, _sync) {
		throw new Error("Not implemented.");
	}
	async access(_filename, _flags) {
		return false;
	}
	async full_pathname(pathname) {
		const db = await db_prom;

		pathname = pathname.replace(/^.*\//, '');

		let [command, rest] = pathname.split(':');
		command = command.toLocaleLowerCase();
		
		let handle, id;
		if (command == 'save') {
			const suggestedName = rest;
			handle = await showSaveFilePicker({
				suggestedName,
				types: [{
					description: 'SQLite Database', accept: {'application/sqlite*': ['.sqlite', '.sqlite3', '.db', '.db3']}
				}]
			});
			id = await db.add('handles', handle);
		}
		else if (command == 'filehandle') {
			[id] = rest.split('-');
			id = Number(id);
			handle = await db.get('handles', id);
		}
		else {
			const description = rest;
			[handle] = await showOpenFilePicker({
				multiple: false,
				types: [{
					description, accept: {'application/sqlite*': ['.sqlite', '.sqlite3', '.db', '.db3']}
				}]
			});
			id = await db.add('handles', handle);
		}

		return `filehandle:${id} - ${handle.name}`;
	}
}
export default new Picker();
