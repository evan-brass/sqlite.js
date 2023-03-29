
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const temp = new BigInt64Array(1);
const tempf = new Float64Array(temp.buffer);
function write_args(data, args) {
	const max_args = data.length - 1;
	if (args.length > max_args) throw new Error("A larger shared array is required to pass this many arguments");
	const types = 0n;
	for (let i = 0; i < args.length; ++i) {
		const arg = args[i];
		if (typeof arg == 'number') {
			// Convert js numeber (float64) to bigint64
			const num = Number(args[i]);
			tempf[0] = num;
			Atomics.store(data, i + 1, temp[0]);
		} else if (typeof arg == 'bigint') {
			types |= 1n << BigInt(i);
			Atomics.store(data, i + 1, arg);
		}
		Atomics.store(data, 0, types);
	}
}
function read_args(data, length) {
	const max_args = data.length - 1;
	if (length > max_args) throw new Error("A larger shared array is required to pass this many arguments");
	const types = data[0];

	const ret = [];
	for (let i = 0; i < length; ++i) {
		const type = types & (1n << BigInt(i));
		if (type) {
			ret.push(Atomics.load(data, i + 1));
		} else {
			temp[0] = Atomics.load(data, i + 1);
			ret.push(tempf[0]);
		}
	}
	return ret;
}

export default async function spawn_in_worker(wasm_source, imports, { max_args = 8, transfer_size = 4096 } = {}) {
	const worker = new Worker(new URL('vm.mjs', import.meta.url), {type: 'module'});
	const sab = new SharedArrayBuffer(4*(1 + 1) + 8*(1 + max_args));
	const transfer = new SharedArrayBuffer(transfer_size);
	const trans = new Uint8Array(transfer);

	const wasm_module = await WebAssembly.compileStreaming(wasm_source);
	const import_defs = WebAssembly.Module.imports(wasm_module);
	const export_defs = WebAssembly.Module.exports(wasm_module);

	const state = new Int32Array(sab, 0, 2); // state[0] = depth, state[1] = opcode / func_idx
	const data = new BigInt64Array(sab, 8);

	worker.postMessage({wasm_module, sab, transfer, import_defs, export_defs});

	const resolves = [];

	let depth = 0;
	function stub(index, ...args) {
		if (depth % 2 == 1) throw new Error("The main thread doesn't have control!");

		return new Promise(res => {
			resolves[depth] = res;
			write_args(data, args);
			Atomics.store(state, 1, index);
			Atomics.store(state, 0, depth + 1);
			Atomics.notify(state, 0);
		});
	};

	// Stub out the exports:
	const exports = {};
	for (let i = 0; i < export_defs.length; ++i) {
		const {name, kind} = export_defs[i];
		// TODO: Support memory and global exports
		if (kind == 'memory') {
			exports[name] = {
				async read(ptr, len) {
					// TODO: Handle larger than transfer.byteLength transfers in parts
					await stub(i, 0, ptr, len);
					const ret = new Uint8Array(len);
					for (let i = 0; i < ret.byteLength; ++i) {
						ret[i] = Atomics.load(trans, i);
					}
				},
				async read_i32(ptr) {
					await stub(i, 3, ptr);
					const [ret] = read_args(data, 1);
					return ret;
				},
				async cstr_len(ptr) {
					await stub(i, 4, ptr);
					const [len] = read_args(data, 1);
					return len;
				},
				async write(ptr, buffer) {
					// TODO: Handle larger than transfer.byteLength transfers in parts
					const buff = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
					for (let i = 0; i < buff.byteLength; ++i) {
						Atomics.store(trans, i, buff[i]);
					}
					await stub(i, 1, ptr, buff.byteLength);
				},
				// Fill is a bytewise-fill (val must be a u8):
				async fill(ptr, len, val = 0) {
					await stub(i, 2, ptr, len, val);
				}
			};
		}
		else if (kind == 'function') {
			exports[name] = stub.bind(undefined, i);
		}
	}

	// Start the execution loop:
	(async () => {
		while (1) {
			await Atomics.waitAsync(state, 0, depth).value;
			depth = Atomics.load(state, 0);
			if (depth % 2 == 1) continue;
			console.log('main', depth);

			const res = resolves[depth];
			if (res) {
				res(read_args(data, 1)[0]);
				resolves[depth] = false;
			} else {
				const def = import_defs[Atomics.load(state, 1)];
				if (def.kind !== 'function') throw new Error('Not function?');
				const func = imports[def.module][def.name];
				if (func === undefined) throw new Error(`Missing import: ${def.module}.${def.name}`);
				const args = read_args(data, func.length);
				(async () => {
					const res = await imports[def.module][def.name](...args);
					Atomics.store(state, 0, depth - 1);
					write_args(data, [res]);
					Atomics.notify(state, 0);
				})();
			}
			// TODO:
		}
	})();

	return exports;
}
self.addEventListener('message', async ({ data: temp }) => {
	const { wasm_module, sab, transfer, import_defs, export_defs } = temp;
	if (!wasm_module || !sab) return; // Not a worker

	const state = new Int32Array(sab, 0, 2); // state[0] = depth, state[1] = opcode / func_idx
	const data = new BigInt64Array(sab, 8); // Argument types and Number arguments
	const trans = new Uint8Array(transfer);

	const imports = {};
	for (let i = 0; i < import_defs.length; ++i) {
		const {module, name, kind} = import_defs[i];
		if (kind != 'function') throw new Error('Only function imports are supported.');

		imports[module] ??= {};
		imports[module][name] = stub.bind(undefined, i);
	}

	const inst = await WebAssembly.instantiate(wasm_module, imports);

	let depth = 0;
	function stub(index, ...args) {
		if (depth % 2 == 0) throw new Error("The worker thread doesn't have control!");
		Atomics.store(state, 1, index);
		write_args(data, args);
		Atomics.store(state, 0, depth + 1);
		Atomics.notify(state, 0);
		return handle(depth);
	}
	function handle(init_depth = depth) {
		while (1) {
			Atomics.wait(state, 0, depth);
			depth = Atomics.load(state, 0);
			if (depth % 2 == 0) continue;
			console.log('worker', depth);

			if (depth == init_depth) {
				return read_args(data, 1)[0];
			} else if (depth > init_depth) {
				const def = export_defs[Atomics.load(state, 1)];
				if (def.kind == 'memory') {
					const [rw, ptr, len, val] = read_args(data, 3);
					const mem8 = new Uint8Array(inst.exports[def.name].buffer);
					if (rw == 2) {
						// Fill
						mem8.fill(val, ptr, ptr + len);
					} else if (rw == 3) {
						// Read i32
						const dv = new DataView(mem8.buffer, mem8.byteOffset, mem8.byteLength);
						write_args(data, [dv.getInt32(ptr, true)]);
					} else if (rw == 4) { 
						// CStr len
						let i;
						for (i = ptr; i < mem8.byteLength && mem8[i] != 0; ++i) {}

						write_args(data, [i - ptr]);
					} else {
						for (let i = 0; i < len; ++i) {
							if (rw == 0) {
								// Read
								Atomics.store(trans, i, mem8[ptr + i]);
							} else if (rw == 1) {
								// Write
								mem8[ptr + i] = Atomics.load(trans, i);
							}
						}
					}
				} else if (def.kind == 'function') {
					const func = inst.exports[def.name];
					const args = read_args(data, func.length);
					const ret = func(...args);
					write_args(data, [ret]);
				}
				Atomics.store(state, 0, depth - 1);
				Atomics.notify(state, 0);
			} else {
				throw new Error("Evan must be a god damned idiot.");
			}
		}
	}
	handle();
}, {once: true});
