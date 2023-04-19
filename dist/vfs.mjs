import { SQLITE_NOTFOUND } from "./sqlite_def.mjs";

class MustOverrideError extends Error {
	constructor() {
		super("Custom VFS implementations must override this method.");
	}
}

export class Vfs {
	name = "mem";
	max_pathname = 64;
	async open(filename, flags) { throw new Error("Default VFS only supports in-memory connections."); }
	async delete(filename, sync) { throw new Error("Default VFS only supports in-memory connections."); }
	async access(filename, flags) { throw new Error("Default VFS only supports in-memory connections."); }
	full_pathname(filename) { return filename; }
}
export class VfsFile {
	sector_size = 0;
	flags = 0;
	async close() { throw new Error("Missing close implementation"); }
	async read(buff, offset) { throw new Error("Missing read implementation"); }
	async write(buff, offset) { throw new Error("Missing write implementation"); }
	async truncate(size) { throw new Error("Missing truncate implementation"); }
	async sync(flags) {}
	async size() { throw new Error("Missing size implementation"); }
	async lock(lock_level) { throw new Error("Missing lock implementation"); }
	async unlock(lock_level) { throw new Error("Missing unlock implementation"); }
	async check_reserved_lock() { throw new Error("Missing check_reserved_lock implementation"); }
	file_control(op, arg) { return SQLITE_NOTFOUND; }
	device_characteristics() { return 0; }
}
