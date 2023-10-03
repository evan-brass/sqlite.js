import "./basics.mjs";
import { Conn } from "../conn.mjs";

function js_eval(js, ...args) {
	if (!js) return;
	return eval(js);
}

Conn.inits.push(function define_eval(conn) {
	conn.create_scalarf(js_eval, {n_args: -1});
});
