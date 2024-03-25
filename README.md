# sqlite.js
Another SQLite wrapper library.

Features:
* Incremental Blob IO via Readable / Writable Streams
* Custom VFSs with async implementations
* Coroutines / "multithreading" via Asyncify stack switching.
	* Enables cancelling a query: `Conn.prototype.interrupt()`
	* Run multiple queries  without needing SharedArrayBuffer or Worker
	* This library compiles SQLite with multithreading support
* An API with minimal construction / destruction.  Prefers 'borrowing' APIs that automatically aquire and release resources.
	* `ConnPool.prototype.borrow()`
	* Once webbrowsers get disaposable/asyncdisposable, then I might rework the APIs to better reflect the underlying SQLite objects.
* Tagged template literals
* Everything is optional: only include what you need.
	* Custom VFSs are optional (if you just want in-memory)
	* Custom scalar-functions are optional (if you don't need incremental blob IO, etc.)
	* Pool is optional
* Extensible
	* Modify how values are bound via the Bindable and Resultable traits in `sql.mjs/value.js`
	* Write your own implementation of custom VFS support.  Look at `sql.mjs/vfs/custom.js` to learn how.
	* Directly call sqlite3 functions via `sql.mjs/sqlite.js` and `sql.mjs/sqlite_def.js`
* Two VFS implementations
	* An HTTP VFS that uses HTTP range queries (if supported by the server) to incrementally query a database
		* Read-only
		* Works in browsers or Deno (uses the fetch api)
	* A browser VFS that operates on FileSystemFileHandle's and FileSystemDirectoryHandle's
		* Uses a virtual filesystem composed of file handles stored in an indexedDB database
