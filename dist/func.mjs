import { Conn } from "./conn.mjs";
import { sqlite3, imports, memdv, alloc_str, handle_error } from "./sqlite.mjs";
import { OutOfMemError, is_promise } from "./util.mjs";
import { JsValue, Value } from "./value.mjs";

const funcs = new Map(); // func_name_ptr -> Func

Conn.prototype.create_scalarf = function create_scalarf(func, { func_name = func.name, flags = 0, n_args = func.length } = {}) {
	const name_ptr = alloc_str(func_name);
	if (!name_ptr) throw new OutOfMemError();
	funcs.set(name_ptr, func);
	const res = sqlite3.create_scalar_function(this.ptr, name_ptr, n_args, flags);
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
			args[i] = new Value(value_ptr);
		}
		function handle_e(e) {
			if (e instanceof OutOfMemError) {
				sqlite3.sqlite3_result_error_nomem(ctx_ptr);
			}
			else {
				const msg_ptr = alloc_str(String(e));
				sqlite3.sqlite3_result_error(ctx_ptr, msg_ptr, -1);
			}
		}
		function handle_val(v) {
			if (!(v instanceof Value)) v = new JsValue(v);
			v.result(ctx_ptr);
		}
		try {
			let ret = func(...args);
			if (is_promise(ret)) {
				return ret.then(handle_val, handle_e);
			}
			handle_val(ret);
		} catch (e) {
			handle_e(e);
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
