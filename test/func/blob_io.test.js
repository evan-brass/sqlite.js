import { assertEquals } from "std/assert/assert_equals.ts";
import { Conn, exec, rows } from 'sqlite.js/conn.js';
import 'sqlite.js/vfs/basics.js';
import 'sqlite.js/func/blob_io.js';

const conn = new Conn();
await conn.open();
await exec(conn.sql`CREATE TABLE test(value TEXT);`);

Deno.test(async function blob_io() {
	const blob = new Blob(["Hello World!"]);
	// TODO: The blob is probably being read as a single read so a future test should do multiple reads to make sure that works.
	await exec(conn.sql`
		BEGIN;
		INSERT INTO test VALUES (zeroblob(${blob.size}));
		SELECT blob_io(${blob.stream()}, (SELECT last_insert_rowid()), 'test', 'value');
		COMMIT;
	`);
	const result = await rows(conn.sql`SELECT CAST(value AS TEXT) FROM test;`);
	assertEquals(result.length, 1);
	const [[value]] = result;
	assertEquals(value, 'Hello World!');
});
