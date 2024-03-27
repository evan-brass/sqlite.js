import { assertEquals } from "std/assert/assert_equals.ts";
import { Conn, rows } from 'sqlite.js/conn.js';
import { Pointer, ZeroBlob } from "sqlite.js/value.js";

const conn = new Conn();
await conn.open();

Deno.test(async function arraybuffer() {
	const [[hex]] = await rows(conn.sql`SELECT hex(${new Uint8Array([222, 173, 190, 239])}) AS hex;`);
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

Deno.test(async function pointer_identity() {
	// We should get the exact same javascript object back when selecting a pointer.
	const p = new (class TestPointer extends Pointer {})();
	const [[res]] = await rows(conn.sql`SELECT ${p};`);
	assertEquals(p, res);
});

Deno.test(async function zeroblob() {
	// Note: We can't use await rows() here because blob types are represented as Uint8Arrays that reference wasm memory and are only valid for the lifetime of that row.
	const rows = conn.sql`SELECT ${new ZeroBlob(15)};`;
	assertEquals(await rows.next(), {
		value: [new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])],
		done: false
	});
	assertEquals(await rows.next(), {value: undefined, done: true});
});

Deno.test(async function real() {
	const [[t]] = await rows(conn.sql`SELECT ${0.55};`);
	assertEquals(t, 0.55);
});

Deno.test(async function booleans() {
	const [[t1]] = await rows(conn.sql`SELECT ${true};`);
	assertEquals(t1, 1);
	const [[t2]] = await rows(conn.sql`SELECT ${false};`);
	assertEquals(t2, 0);
});
