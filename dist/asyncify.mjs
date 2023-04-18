let value, stack;
const State = {
	None: 0,
	Unwinding: 1,
	Rewinding: 2
};

export class OutOfMemError extends Error {
	constructor() {
		super("Out of Memory");
	}
}

export function is_promise(val) {
	return ['object', 'function'].includes(typeof val) && typeof val?.then == 'function';
}

export default async function asyncify(module, imports, {stack_size = 1024} = {}) {
	// Make a module from the source:
	if (!(module instanceof WebAssembly.Module)) {
		module = await WebAssembly.compileStreaming(module);
	}

	const import_defs = WebAssembly.Module.imports(module);
	const export_defs = WebAssembly.Module.exports(module);

	// Wrap the imports with asyncify stubs
	const wrapped_imports = {};
	for (const {module, name, kind} of import_defs) {
		wrapped_imports[module] ??= {};
		if (kind == 'function') {
			wrapped_imports[module][name] = import_stub.bind(undefined, module, name);
		} else {
			wrapped_imports[module][name] = imports[module][name];
		}
	}

	// Instantiate
	const instance = await WebAssembly.instantiate(module, wrapped_imports);
	const exports = instance.exports;

	// We only need a stack when an import returns a promise
	// TODO: Make a config option to override this function
	const stacks = [];
	function get_stack() {
		if (stacks.length) return stacks.pop();

		const ptr = exports.malloc(stack_size);
		if (!ptr) throw new OutOfMemError();
		
		const dv = new DataView(exports.memory.buffer ?? imports?.env?.memory?.buffer);
		dv.setInt32(ptr, ptr + 8, true);
		dv.setInt32(ptr + 4, ptr + stack_size, true);

		return ptr;
	}

	// Import and Export stubs:
	function import_stub(module, name, ...args) {
		const state = exports.asyncify_get_state();
		if (state == State.Rewinding) {
			exports.asyncify_stop_rewind();
			stacks.push(stack);
			const ret = value;
			value = stack = undefined;
			return ret;
		}
		if (state == State.Unwinding) throw new Error("Corruption!");

		let result = imports[module][name](...args);
		if (is_promise(result)) {
			value = result;
			stack = get_stack();
			exports.asyncify_start_unwind(stack);
			return;
		}
		return result;
	}
	// Unlike https://github.com/GoogleChromeLabs/asyncify, this export stub only returns a promise if we encounter unwinding.
	function export_stub(name, ...args) {
		let result = exports[name](...args);
		if (exports.asyncify_get_state() == State.Unwinding) {
			return (async () => {
				do {
					exports.asyncify_stop_unwind();
					const save_stack = stack;
					const prom = value;
					value = stack = undefined;
					value = await prom;
					stack = save_stack;
					exports.asyncify_start_rewind(save_stack);
					result = exports[name]();
				} while (exports.asyncify_get_state() == State.Unwinding);

				return result;
			})();
		}
		return result;
	}

	// Wrap the exports:
	const ret = {};
	for (const {name, kind} of export_defs) {
		ret[name] = (kind == 'function') ? export_stub.bind(null, name) : exports[name];
	}

	// Return the wrapped exports
	return ret;
}
