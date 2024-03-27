import { assertEquals, assertNotEquals } from 'std/assert/mod.ts';
import { rows, Conn } from "sqlite.js/conn.js";
import 'sqlite.js/vfs/basics.js';

const conn = new Conn();
await conn.open();

/**
 * vfs/basics provides environment access to random numbers (through crypto.getRandomValues) and the current time (through Date.now).
 * I'm not currently checking that these are accurate, just that they don't throw.
 */

Deno.test(async function randomness() {	
	const [[t1]] = await rows(conn.sql`SELECT hex(randomblob(20)) AS random;`);
	const [[t2]] = await rows(conn.sql`SELECT hex(randomblob(20)) AS random;`);

	assertEquals(typeof t1, 'string');
	assertEquals(t1.length, 40);
	assertNotEquals(t1, t2);
});

Deno.test(async function datetime() {
	const [[now]] = await rows(conn.sql`SELECT datetime() AS now;`);

	assertEquals(typeof now, 'string');
});
