# sql.mjs
Another SQLite library.  Mostly inactive, and very unstable (MAY CORRUPT YOUR DATABASE FILE), but also cool I think.

Features:
* Incremental Blob IO via Readable / Writable Streams
* Custom VFSs with async implementations
* Coroutines / "multithreading" via Asyncify stack switching.
	* Enables cancelling a query: `Conn.prototype.interrupt()`
	* Run multiple queries  without needing SharedArrayBuffer or Worker
* An API with minimal construction / destruction.  Prefers 'borrowing' APIs that automatically aquire and release resources.
	* `ConnPool.prototype.borrow()`
* Tagged template literals
* Everything is optional: only include what you need.
	* Custom VFSs are optional (if you just want in-memory)
	* Custom scalar-functions are optional (if you don't need incremental blob IO, etc.)
	* Pool is optional
* Extensible
	* Modify how values are bound via the Bindable and Resultable traits in `sql.mjs/value.mjs`
	* Write your own implementation of custom VFS support.  Look at `sql.mjs/vfs/custom.mjs` to learn how.
	* Directly call sqlite3 functions via `sql.mjs/sqlite.mjs` and `sql.mjs/sqlite_def.mjs`
