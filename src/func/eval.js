import "./basics.js";
import { Conn } from "../conn.js";

function js_eval(js, ...args) {
	if (!js) return;
	return eval(js);
}

Conn.inits.push(function define_eval(conn) {
	conn.create_scalarf(js_eval, {n_args: -1, func_name: 'eval'});
});
