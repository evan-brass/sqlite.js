import { assertEquals } from "std/assert/assert_equals.ts";
import {Conn} from 'sqlite.js/conn.js';

const conn = new Conn();
await conn.open();

Deno.test(async function column_names() {
	const stmts = conn.stmts`SELECT 'Hello World!' AS greet; SELECT 5 AS num1, 15.2 AS num2;`;
	const {value: s1} = await stmts.next();
	assertEquals(s1.column_names, ['greet']);
	const {value: s2} = await stmts.next();
	assertEquals(s2.column_names, ['num1', 'num2']);
});
