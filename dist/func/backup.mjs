import './basics.mjs';
import { Pointer, Bindable } from "../value.mjs";
import { OpenParams } from "../conn.mjs";
import { Conn } from "../conn.mjs";
import { mem8, memdv, sqlite3 } from "../sqlite.mjs";
import { borrow_mem, handle_error } from "../memory.mjs";


Conn.inits.push(function define_backup(conn) {
	conn.create_scalarf(backup_to, {n_args: backup.length});
	conn.create_scalarf(backup_to, {n_args: backup.length + 1});
});

function backup_from(src, db_name = 'main') {
	
}

function backup_to(dst, db_name = 'main') {
	if (!(dst instanceof OpenParams)) {
		if (typeof dst != 'string') throw new Error('First argument to backup must either be an OpenParams or a string.');
		dst = new OpenParams({pathname: dst});
	}
	// TODO: Let dest be an OpenParams?  OpenParams would then need to be a Pointer...
	if (typeof dst != 'string') throw new Error('The first argument to backup must be a pathname string.');
	const src_conn = this.db;
	return borrow_mem([4, dst.pathname, dst.vfs, db_name, 'main'], async (dst_conn_ptr, dst_pathname, dst_vfs, src_db_name, dst_db_name) => {
		let dst_conn;
		let backup = 0;
		try {
			// Open the destination connection:
			const res = await sqlite3.sqlite3_open_v2(dst_pathname, dst_conn_ptr, dst.flags, dst_vfs);
			dst_conn = memdv().getInt32(dst_conn_ptr);
			handle_error(res, dst_conn);

			// Initialize the Backup:
			backup = await sqlite3.sqlite3_backup_init(dst_conn, dst_db_name, src_conn, src_db_name);
			if (!backup) handle_error(sqlite3.sqlite3_errcode(dst_conn), dst_conn); // This should always throw

			
		} finally {
			sqlite3.sqlite3_backup_finish(backup);
			sqlite3.sqlite3_close_v2(dst_conn);
		}
	});
}
