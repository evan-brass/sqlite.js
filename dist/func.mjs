import { Conn } from "./conn.mjs";
import { sqlite3, imports, memdv, handle_error } from "./sqlite.mjs";
import { dyn_s, free_s } from "./strings.mjs";
import { OutOfMemError, is_promise } from "./util.mjs";
import { Resultable, value_to_js } from "./value.mjs";

const funcs = new Map(); // func_name_ptr -> Func

Conn.prototype.create_scalarf = function create_scalarf(func, { func_name = func.name, flags = 0, n_args = func.length } = {}) {
	const name = dyn_s(func_name, { unique: true });
	if (!name) throw new OutOfMemError();
	funcs.set(name.ptr, func);
	const res = sqlite3.create_scalar_function(this.ptr, name, n_args, flags);
	handle_error(res, this.ptr);
};

function get_func(ctx_ptr) {
	const name_ptr = sqlite3.sqlite3_user_data(ctx_ptr);
	const func = funcs.get(name_ptr);
	if (!func) throw new Error("Unknown function?");
	return func;
}

imports['func'] = {
	xFunc(ctx_ptr, num_args, args_ptr) {
		const func = get_func(ctx_ptr);
		const args = [];
		const dv = memdv();
		for (let i = 0; i < num_args; ++i) {
			const value_ptr = dv.getInt32(args_ptr + 4 * i, true);
			args[i] = value_to_js(value_ptr);
		}
		const handle = v => Resultable.result(ctx_ptr, v);
		try {
			let ret = func(...args);
			if (is_promise(ret)) {
				return ret.then(handle, handle);
			}
			handle(ret);
		} catch (e) {
			handle(e);
		}
	},
	xStep(ctx_ptr, num_args, args_ptr) {
		const func = get_func(ctx_ptr);
		debugger;
	},
	xFinal(ctx_ptr) {
		const func = get_func(ctx_ptr);
		debugger;
	},
	xDestroy(func_name_ptr) {
		funcs.delete(func_name_ptr);
		sqlite3.free(func_name_ptr);
		debugger;
	},
	xValue(ctx_ptr) {
		const func = get_func(ctx_ptr);
		debugger;
	},
	xInverse(ctx_ptr) {
		const func = get_func(ctx_ptr);
		debugger;
	}
};
