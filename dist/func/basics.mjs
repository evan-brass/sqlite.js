/**
 * basics.mjs - Adds support for defining / running custom scalar functions
 */

import { Conn } from "../conn.mjs";
import { sqlite3, imports, memdv } from "../sqlite.mjs";
import { is_promise } from "../util.mjs";
import { Resultable, value_to_js } from "../value.mjs";
import { leaky, handle_error } from "../memory.mjs";

const funcs = new Map(); // func_name_ptr -> Func

let func_i = 0;

Conn.prototype.create_scalarf = function create_scalarf(func, { func_name = func.name, flags = 0, n_args = func.length } = {}) {
	const fi = ++func_i;
	funcs.set(fi, func);
	const res = sqlite3.create_scalar_function(this.ptr, leaky(func_name), fi, n_args, flags);
	handle_error(res, this.ptr);
};

function get_func(ctx_ptr) {
	const name_ptr = sqlite3.sqlite3_user_data(ctx_ptr);
	const func = funcs.get(name_ptr);
	if (!func) throw new Error("Unknown function?");
	return func;
}

class FuncCtx {
	ctx_ptr;
	num_args;
	args_ptr;
	constructor() { Object.assign(this, ...arguments); }
	get db() {
		return sqlite3.sqlite3_context_db_handle(this.ctx_ptr);
	}
	value_ptr(i) {
		if (i >= this.num_args) return;
		return memdv().getInt32(this.args_ptr + 4 * i, true);
	}
	*args() {
		for (let i = 0; i < this.num_args; ++i) {
			const vp = this.value_ptr(i);
			yield value_to_js(vp);
		}
	}
	get func() {
		const name_ptr = sqlite3.sqlite3_user_data(this.ctx_ptr);
		const ret = funcs.get(name_ptr);
		if (!ret) throw new Error("Unknown function?");
		return ret;
	}
	call() {
		const handle = v => Resultable.result(this.ctx_ptr, v);
		try {
			const ret = this.func.call(this, ...this.args());
			if (is_promise(ret)) return ret.then(handle, handle);
			handle(ret);
		} catch (e) {
			handle(e);
		}
	}
}

imports['func'] = {
	xFunc(ctx_ptr, num_args, args_ptr) {
		const ctx = new FuncCtx({ ctx_ptr, num_args, args_ptr });
		return ctx.call();
	},
	xStep(ctx_ptr, num_args, args_ptr) {
		const func = get_func(ctx_ptr);
		debugger;
	},
	xFinal(ctx_ptr) {
		const func = get_func(ctx_ptr);
		debugger;
	},
	xDestroy(fi) {
		funcs.delete(fi);
		// sqlite3.free(func_name_ptr);
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
