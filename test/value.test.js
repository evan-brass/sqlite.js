import { assertEquals } from "std/assert/assert_equals.ts";
import { Conn, rows } from 'sqloaf/conn.js';

const conn = new Conn();
await conn.open();

Deno.test(async function arraybuffer() {
	const [{ hex }] = await rows(conn.sql`SELECT hex(${new Uint8Array([222, 173, 190, 239])}) AS hex;`);
	assertEquals(hex, 'DEADBEEF');
});

Deno.test(async function max_safe_integer() {
	const [[one_under, max, one_over]] = await rows(conn.sql`SELECT ${Number.MAX_SAFE_INTEGER} - 1, ${Number.MAX_SAFE_INTEGER}, ${Number.MAX_SAFE_INTEGER} + 1;`);
	assertEquals(one_under, Number.MAX_SAFE_INTEGER - 1);
	assertEquals(max, Number.MAX_SAFE_INTEGER);
	assertEquals(one_over, BigInt(Number.MAX_SAFE_INTEGER) + 1n);
});

Deno.test(async function min_safe_integer() {
	const [[one_under, min, one_over]] = await rows(conn.sql`SELECT ${Number.MIN_SAFE_INTEGER} - 1, ${Number.MIN_SAFE_INTEGER}, ${Number.MIN_SAFE_INTEGER} + 1;`);
	assertEquals(one_under, BigInt(Number.MIN_SAFE_INTEGER) - 1n);
	assertEquals(min, Number.MIN_SAFE_INTEGER);
	assertEquals(one_over, Number.MIN_SAFE_INTEGER + 1);
});
