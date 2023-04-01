/**
 * We use two shared array buffers.  One for arguments, and one for memory data transfer.
 * Arguments:
 * +--i32--+--i32--+--i64--+----[i64]-----+
 * | depth | index | types | arguments... |
 * +-------+-------+-------+--------------+
 * The count field is used to un-suspend the worker thread.  It is incremented and notified by the main thread.  When the worker suspends, it posts a message back with either a return value or a function call.  Atomics.waitAsync doesn't have full support yet, and even if it did it's still been difficult to pass arguments / values back and forth using the same system.
 * 
 * To indicate which export we're calling, we set the index field.  We index into the definitions returned from WebAssembly.Module.exports.
 * 
 * We only support numeric arguments: Number or Bigint.  The types field is a bitmap of which arguments are numbers and which are bigints.  Since the types field is 64 bits, we can support a maximum of 64 arguments per exported function.
 * 
 * The arguments are stored either as f64 or i64.  Since Atomics.store / Atomics.load only works with integer typed arrays, we need to convert the f64 to an i64 before setting it.
 * 
 * To determine how many arguments to pass to an exported function / imported function, we use the function's length: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/length  For both imports and exports, the side that executes the function will know how many arguments based on the length, and the calling side knows how many arguments to push because it is given an argument list.
 * 
 * A second SharedArrayBuffer is used to transfer memory into the worker.  Since we're using post message, we can post message memory buffers out of the worker: the transfer buffer is only used when writing memory from main->worker.
 * When writing sections of memory larger than the transfer buffer's size, we have to copy it in pieces.
 */
if (typeof SharedArrayBuffer != 'function') {
	throw new Error('Shared array buffer is required: https://developer.mozilla.org/en-US/docs/Web/API/crossOriginIsolated');
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function f2b(float) {
	const out = new BigInt64Array(1);
	new Float64Array(out.buffer)[0] = float;
	return out[0];
}
function b2f(bigint) {
	const out = new Float64Array(1);
	new BigInt64Array(out.buffer)[0] = bigint;
	return out[0];
}

function make_state(shared_buffer, transfer_buffer) {
	const i32 = new Int32Array(shared_buffer);
	const i64 = new BigInt64Array(shared_buffer, 8);
	const max_args = Math.min(i64.length - 1, 64);
	const trans = new Uint8Array(transfer_buffer);

	return {
		// Used to call exports:
		call(i, ...args) {
			Atomics.store(i32, 1, i);
			this.write_args(...args);
			Atomics.add(i32, 0, 1);
			Atomics.notify(i32, 0);
		},
		// Used by the worker to suspend:
		suspend() {
			const v = Atomics.load(i32, 0);
			Atomics.wait(i32, 0, v);
		},
		get depth() { return Atomics.load(i32, 0); },
		set depth(val) { Atomics.store(i32, 0, val); Atomics.notify(i32, 0); },
		get index() { return Atomics.load(i32, 1); },
		set index(val) { Atomics.store(i32, 1, val); },
		// Arguments:
		get types() { return Atomics.load(i64, 0); },
		set types(val) { Atomics.store(i64, 0, val); },
		write_args(...args) {
			if (args.length > max_args) throw new Error("Can't handle this many arguments.");
			let types = 0n;
			for (let i = 0; i < args.length; ++i) {
				let arg = args[i];
				if (typeof arg == 'boolean') arg = Number(arg); // Convert booleans into numbers
				if (typeof arg == 'number') {
					types |= 1n << BigInt(i);
					arg = f2b(arg);
				}
				if (typeof arg != 'bigint') throw new Error("Can't write this type of argument.");
				Atomics.store(i64, i + 1, arg);
			}
			this.types = types;
		},
		read_args(num_args) {
			if (num_args > max_args) throw new Error("Can't handle this many arguments.");
			const types = this.types;
			const ret = [];
			for (let i = 0; i < num_args; ++i) {
				const is_number = Boolean(types & (1n << BigInt(i)));
				let arg = Atomics.load(i64, i + 1);
				if (is_number) arg = b2f(arg);
				ret.push(arg);
			}
			return ret;
		},
		start_call(index, ...args) {
			this.index = index;
			this.write_args(...args);
			this.depth += 1;
		},
		return(ret_val = 0) {
			this.write_args(ret_val);
			this.depth -= 1;
		},
		wait(depth) {
			Atomics.wait(i32, 0, depth);
			return this.depth;
		},
		// Read / write from the transfer buffer:
		write_transfer(buffer) {
			if (buffer.byteLength > trans.byteLength) throw new Error('Buffer larger than the transfer buffer.');
			const u8 = new Uint8Array(ArrayBuffer.isView(buffer) ? buffer.buffer : buffer, buffer.byteOffset ?? 0, buffer.byteLength);
			for (let i = 0; i < u8.byteLength; ++i) {
				Atomics.store(trans, i, u8[i]);
			}
		},
		read_transfer(buffer) {
			if (buffer.byteLength > transfer_buffer.byteLength) throw new Error('Buffer larger than the transfer buffer.');
			const u8 = new Uint8Array(ArrayBuffer.isView(buffer) ? buffer.buffer : buffer, buffer.byteOffset ?? 0, buffer.byteLength);
			for (let i = 0; i < u8.byteLength; ++i) {
				u8[i] = Atomics.load(trans, i);
			}
		}
	};
}

export default async function spawn_in_worker(wasm_source, imports, { max_args = 8, transfer_size = 4096 } = {}) {
	const sab = new SharedArrayBuffer(4 + 4 + 8 + 8 * max_args);
	const transfer = new SharedArrayBuffer(transfer_size);

	const wasm_module = (wasm_source instanceof WebAssembly.Module) ? wasm_source : await WebAssembly.compileStreaming(wasm_source);
	const export_defs = WebAssembly.Module.exports(wasm_module);

	const state = make_state(sab, transfer);

	const worker = new Worker(import.meta.url, {type: 'module'});
	worker.addEventListener('error', console.error);
	worker.addEventListener('message', ({data}) => console.log('message', data));
	worker.addEventListener('messageerror', console.warn);
	worker.addEventListener('rejectionhandled', console.warn);
	worker.addEventListener('unhandledrejection', console.error);
	worker.postMessage({wasm_module, sab, transfer, export_defs});

	const exports = {
		terminate() { worker.terminate(); }
	};
	const resolves = [];
	worker.addEventListener('message', async ({ data }) => {
		const { ret_val } = data;
		if (ret_val) {
			resolves.pop()(ret_val);
		} else {
			const { module, name, args } = data;
			const ret = await imports[module][name](...args);
			state.return(ret);
		}
	});
	function call(i, ...args) {
		return new Promise(res => {
			resolves.push(res);
			state.start_call(i, ...args);
		});
	}
	for (let i = 0; i < export_defs.length; ++i) {
		const {name, kind} = export_defs[i];
		if (kind == 'memory') {
			exports[name] = {
				read(ptr, len) {
					return call(i, 0, ptr, len);
				},
				async write(ptr, src) {
					let i = 0;
					while (i < src.byteLength) {
						const buff = new Uint8Array(src.buffer, src.byteOffset + i, Math.min(src.byteLength - i, transfer_size));
						state.write_transfer(buff);
						await call(i, 1, ptr + i, buff.byteLength);

						i += buff.byteLength;
					}
				},
				read_cstr(ptr) { debugger; }
			};
			// TODO: Support DataView operations
		}
		else if (kind == 'function') {
			exports[name] = function stub(...args) {
				return call(i, ...args);
			};
		}
	}
	
	return exports;
}
self.addEventListener('message', async ({ data: temp }) => {
	const { wasm_module, sab, transfer, export_defs } = temp;
	if (!wasm_module || !sab) return; // Oops.

	const import_defs = WebAssembly.Module.imports(wasm_module);

	const state = make_state(sab, transfer);

	const imports = {};
	for (let i = 0; i < import_defs.length; ++i) {
		const {module, name, kind} = import_defs[i];
		if (kind != 'function') throw new Error('Only function imports are supported.');

		imports[module] ??= {};
		imports[module][name] = function stub(...args) {
			const depth = state.depth;
			self.postMessage({ module, name, args });
			return handler(depth + 1);
		}
	}

	const inst = await WebAssembly.instantiate(wasm_module, imports);

	function handler(depth = 0) {
		let current_depth = depth;
		while (1) {
			current_depth = state.wait(current_depth);
			if (current_depth > depth) {
				const {name, kind} = export_defs[state.index];
				const exp = inst.exports[name];
				if (kind == 'function') {
					const args = state.read_args(exp.length);
					const ret_val = exp(...args);
					self.postMessage({ ret_val });
				}
				else if (kind == 'memory') {
					const [sub_op, ptr, len] = state.read_args(3);
					const buff = new Uint8Array(exp.buffer, ptr, len);
					if (sub_op == 0) {
						const ret_val = buff.slice();
						self.postMessage({ ret_val }, [ret_val]);
					}
					else if (sub_op == 1) {
						// Write to memory:
						state.read_transfer(buff);
					}
					else {
						debugger;
					}
				}
			} else if (current_depth < depth) {
				return state.read_args(1)[0];
			} else {
				console.log('¿equal?');
			}
		}
	};
	handler();
	console.error('Should be unreachable!')
	debugger;
}, {once: true});
