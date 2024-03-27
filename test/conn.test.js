import { assertEquals } from "std/assert/assert_equals.ts";
import {Conn} from 'sqlite.js/conn.js';

const conn = new Conn();
await conn.open();

Deno.test(async function column_names() {
	const stmts = await conn.prepare("SELECT 'Hello World!' AS greet; SELECT 5 AS num1, 15.2 AS num2;");
	assertEquals(stmts.length, 2);
	const [s1, s2] = stmts;
	assertEquals(s1.column_names, ['greet']);
	assertEquals(s2.column_names, ['num1', 'num2']);
});
