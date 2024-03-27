import { assertEquals } from 'std/assert/mod.ts';
import { exec, Conn, rows } from "sqlite.js/conn.js";
import 'sqlite.js/vfs/http.js?register';

const conn = new Conn();
await conn.open();

// TODO: Use a local file URL instead of http
Deno.test(async function load_zipcodes() {	
	await exec(conn.sql`ATTACH 'file://cdn.jsdelivr.net/gh/alex-hofsteede/zipcode_db/zipcodes.sqlite?vfs=http' AS zipcodes;`);
	const result = await rows(conn.sql`SELECT cities.name AS city, states.name AS state FROM zipcodes
		INNER JOIN cities ON zipcodes.city_id = cities.id
		INNER JOIN states ON zipcodes.state_id = states.id
		WHERE zip = 97702
	;`);
	assertEquals(result.length, 1);
	const [[city, state]] = result;
	assertEquals(city, 'Bend');
	assertEquals(state, 'OR');
});
