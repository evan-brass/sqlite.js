/**
 * +--i32--+--i32--+--i64--+----[i64]-----+
 * |  op   | index | types | arguments... |
 * +-------+-------+-------+--------------+
 * op 0: No-Op
 * op 1: Call
 * op 2: Return
 */
if (typeof SharedArrayBuffer != 'function') {
	throw new Error('Shared array buffer is required: https://developer.mozilla.org/en-US/docs/Web/API/crossOriginIsolated');
}

const conv_b = new BigInt64Array(1);
const conv_f = new Float64Array(conv_b.buffer);
function f2b(float) {
	conv_f[0] = float;
	return conv_b[0];
}
function b2f(bigint) {
	conv_b[0] = bigint;
	return conv_f[0];
}

class WrappedDataView extends DataView {
	#mem;
	ptr;
	#u8;
	constructor(mem, ptr, len) {
		super(new ArrayBuffer(len))
		this.#mem = mem;
		this.ptr = ptr;
		this.#u8 = new Uint8Array(this.buffer, this.byteOffset, this.byteLength);
	}
	async load() {
		const read = await this.#mem.read(this.ptr, this.byteLength);
		this.#u8.set(read);
		return this;
	}
	async store() {
		await this.#mem.write(this.ptr, this.#u8);
		return this;
	}
}

export default async function spawn_in_worker(wasm_source, imports, { max_args = 8, transfer_size = 4096 } = {}) {
	const sab = new SharedArrayBuffer(4 + 4 + 8 + 8 * max_args);
	const transfer = new SharedArrayBuffer(transfer_size);

	const i32 = new Int32Array(sab);
	const i64 = new BigInt64Array(sab, 8);
	const trans = new Uint8Array(transfer);

	function write_args(args) {
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
		Atomics.store(i64, 0, types);
	}
	function write_transfer(src) {
		if (src.byteLength > trans.byteLength) throw new Error('Buffer larger than the transfer buffer.');
		const u8 = new Uint8Array(ArrayBuffer.isView(src) ? src.buffer : src, src.byteOffset ?? 0, src.byteLength);
		for (let i = 0; i < u8.byteLength; ++i) {
			Atomics.store(trans, i, u8[i]);
		}
	}
	const stack = [];
	function call(i, ...args) {
		return new Promise((res, rej) => {
			stack.push([res, rej]);
			write_args(args);
			Atomics.store(i32, 1, i);
			Atomics.store(i32, 0, 1);
			Atomics.notify(i32, 0, 1);
		});
	}
	function ret(val) {
		write_args([val ?? 0]);
		Atomics.store(i32, 0, 2);
		Atomics.notify(i32, 0);
	}

	const wasm_module = (wasm_source instanceof WebAssembly.Module) ? wasm_source : await WebAssembly.compileStreaming(wasm_source);
	const export_defs = WebAssembly.Module.exports(wasm_module);

	const worker = new Worker(import.meta.url, {type: 'module'});
	worker.addEventListener('message', async ({ data }) => {
		if ('ret_val' in data) {
			stack.pop()[0](data.ret_val);
		} else {
			const { module, name, args } = data;
			const val = await imports[module][name](...args);
			ret(val);
		}
	});
	function empty_stack(e) {
		console.error(e);
		while (stack.length) {
			stack.pop()[1](e);
		}
	}
	worker.addEventListener('error', empty_stack);
	worker.addEventListener('unhandledrejection', empty_stack);
	worker.addEventListener('messageerror', empty_stack);

	const exports = {
		terminate() { worker.terminate(); }
	};
	for (let index = 0; index < export_defs.length; ++index) {
		const {name, kind} = export_defs[index];
		if (kind == 'memory') {
			exports[name] = {
				read(ptr, len) {
					return call(index, 0, ptr, len);
				},
				async write(ptr, src) {
					let i = 0;
					while (i < src.byteLength) {
						const buff = new Uint8Array(src.buffer, src.byteOffset + i, Math.min(src.byteLength - i, transfer_size));
						write_transfer(buff);
						await call(index, 1, ptr + i, buff.byteLength);

						i += buff.byteLength;
					}
				},
				fill(ptr, len, val) {
					return call(index, 2, ptr, len, val);
				},
				strlen(ptr) {
					return call(index, 3, ptr);
				},
				dv(ptr, len = 8) {
					return new WrappedDataView(this, ptr, len);
				}
			};
			// TODO: Support DataView operations
		}
		else if (kind == 'function') {
			exports[name] = function stub(...args) {
				return call(index, ...args);
			};
		}
	}

	// Start the worker running:
	worker.postMessage({wasm_module, sab, transfer, export_defs});
	
	return exports;
}
self.addEventListener('message', async ({ data: temp }) => {
	const { wasm_module, sab, transfer, export_defs } = temp;
	if (!wasm_module || !sab) return; // Oops.

	const import_defs = WebAssembly.Module.imports(wasm_module);

	const i32 = new Int32Array(sab);
	const i64 = new BigInt64Array(sab, 8);
	const max_args = Math.min(i64.length - 1, 64);
	const trans = new Uint8Array(transfer);

	function read_args(num_args) {
		if (num_args > max_args) throw new Error("Can't handle this many arguments.");
		const types = Atomics.load(i64, 0);
		const ret = [];
		for (let i = 0; i < num_args; ++i) {
			const is_number = Boolean(types & (1n << BigInt(i)));
			let arg = Atomics.load(i64, i + 1);
			if (is_number) arg = b2f(arg);
			ret.push(arg);
		}
		return ret;
	}
	function read_transfer(dst) {
		if (dst.byteLength > trans.byteLength) throw new Error('Buffer larger than the transfer buffer.');
		const u8 = new Uint8Array(ArrayBuffer.isView(dst) ? dst.buffer : dst, dst.byteOffset ?? 0, dst.byteLength);
		for (let i = 0; i < u8.byteLength; ++i) {
			u8[i] = Atomics.load(trans, i);
		}
	}

	const imports = {};
	for (let i = 0; i < import_defs.length; ++i) {
		const {module, name, kind} = import_defs[i];
		if (kind != 'function') throw new Error('Only function imports are supported.');

		imports[module] ??= {};
		imports[module][name] = function stub(...args) {
			self.postMessage({ module, name, args });
			return handler();
		}
	}

	const inst = await WebAssembly.instantiate(wasm_module, imports);

	function handler() {
		while (1) {
			Atomics.wait(i32, 0, 0);
			const op = Atomics.load(i32, 0);
			Atomics.store(i32, 0, 0);
			if (op == 0) { continue; /* No Op */ }
			else if (op == 1) {
				const index = Atomics.load(i32, 1);
				const {name, kind} = export_defs[index];
				const exp = inst.exports[name];
				if (kind == 'function') {
					const args = read_args(exp.length);
					const ret_val = exp(...args);
					self.postMessage({ ret_val });
				}
				else if (kind == 'memory') {
					const [sub_op, ptr, len, val] = read_args(4);
					if (sub_op == 3) {
						const mem8 = new Uint8Array(exp.buffer, ptr);
						let i;
						for (i = 0; i < mem8.byteLength && mem8[i] != 0; ++i) {}
						self.postMessage({ ret_val: i });
					} else {
						const buff = new Uint8Array(exp.buffer, ptr, len);
						if (sub_op == 0) {
							// Read from memory:
							const ret_val = buff.slice();
							self.postMessage({ ret_val }, [ret_val.buffer]);
						}
						else if (sub_op == 1) {
							// Write to memory:
							read_transfer(buff);
							self.postMessage({ ret_val: true });
						}
						else if (sub_op == 2) {
							// Fill memory:
							buff.fill(val);
							self.postMessage({ ret_val: undefined });
						}
					}
				}
			}
			else if (op == 2) {
				const [val] = read_args(1);
				return val;
			} else {
				throw new Error("Unrecognized opcode");
			}
		}
	};
	handler();
	console.error('Should be unreachable!')
	debugger;
}, {once: true});
