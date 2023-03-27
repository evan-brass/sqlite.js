/**
 * Opcodes[Calling]:
 * 0 - NoOp: ()
 * 1 - LiteralF64: () -> Number
 * 2 - LiteralI64: () -> BigInt
 * 3 - Call: (func_idx, ...args)
 * 4 - Return: (ret_val)
 * Opcodes[Memory]:
 * 5 - Read: (ptr, len)
 * 6 - Write: (ptr, len)
 */

class InstStream {
	#ptrs;
	#func_names;
	#typed;
	constructor(buffer, func_names = []) {
		this.#func_names = func_names;
		// Two pointers for the ring buffer
		this.#ptrs = new Uint32Array(buffer, 0, 2);
		this.#typed = {
			i32: new Uint32Array(buffer, this.#ptrs.byteLength),
			i64: new BigInt64Array(buffer, this.#ptrs.byteLength),
			f64: new Float64Array(buffer, this.#ptrs.byteLength)
		};
	}
	get head() {
		return Atomics.load(this.#ptrs, 0);
	}
	get tail() {
		return Atomics.load(this.#ptrs, 1);
	}
	get available() {
		const size = this.#typed.f64.length;
		if (this.head == tail) {
			// When this.head == this.tail, it could either be full or empty.  We have to pick one, so we choose that this means the queue is empty.
			return size;
		} else if (this.head < this.tail) {
			return this.head + size - this.tail;
		} else {
			return this.head - this.tail;
		}
	}
	async call_async(func_name, ...args) {
		const func_idx = this.#func_names.indexOf(func_name);
		if (func_idx == -1) throw new Error();
		for (const arg of args.reverse()) {
			if (typeof arg == 'boolean') arg = arg ? 1 : 0;
			if (typeof arg == 'number') {
				// Store it as an f64
			}
			else if (typeof arg == 'bigint') {
				// Store it as an i64
			}
		}
	}
	call(func_name, ...args) {

	}
}

export default async function instantiate(worker_url, module_url, {
	env = {},
	inst_size = 100,
	data_size = 1024
}) {
	// Create the worker:
	const worker = new Worker(worker_url, {type: 'module'});
	const sab1 = new SharedArrayBuffer(inst_size);
	const sab2 = new SharedArrayBuffer(inst_size);
	const sab3 = new SharedArrayBuffer(data_size);
	const import_names = Object.keys(env);
	worker.postMessage({ sab1, sab2, sab3, import_names, module_url });

	const worker_stream = new InstStream(sab1);
	const manager_stream = new InstStream(sab2);
	
	const { data: { export_names } } = await new Promise(res => worker.addEventListener('message', res, {once: true}));

	// Spawn the 


	async function vm_exec(send_queue = []) {
		let ip = 0;
		// TODO: Serialize calls to vm_exec?
		await (Atomics.waitAsync(lock, 0, 1).value);
		async function yiield() {
			inst.fill(0, ip);
			Atomics.store(lock, 0, 1);
			Atomics.notify(lock, 0, 1);
			await (Atomics.waitAsync(lock, 0, 1).value);
			ip = 0;
		}
		async function write_op(op) {
			if (typeof op == 'boolean') op = Number(op);
			if (typeof op == 'number') {
				if (ip + 9 >= inst.byteLength) await yiield();
				inst[ip++] = 1;
				inst_dv.setFloat64(ip, op);
				ip += 8;
			}
			else if (typeof op == 'bigint') {
				if (ip + 9 >= inst.byteLength) await yiield();
				inst[ip++] = 2;
				inst_dv.setBigInt64(ip, op);
				ip += 8;
			}
			else if (op == Call) {
				if (ip >= inst.byteLength) await yiield();
				inst[ip++] = 3;
			}
			else if (op == Return) {
				if (ip >= inst.byteLength) await yiield();
				inst[ip++] = 4;
			}
		}
		for (let op of send_queue) {
			await write_op(op);
		}
		
		// Execute instructions sent back to us:
		while (1) {
			while (ip < inst.byteLength) {
				const opcode = inst[ip++];
				if (opcode == 0) { break; }
				else if (opcode == 1) {
					stack.push(inst_dv.getFloat64(ip));
					ip += 8;
				}
				else if (opcode == 2) {
					stack.push(inst_dv.getBigInt64(ip));
					ip += 8;
				}
				else if (opcode == 3) {
					const func_idx = stack.pop();
					const func_name = import_names[func_idx];
					const func = env[func_name];
					const args = [];
					for (let i = 0; i < func.length; ++i) { args.push(stack.pop()); }
					const ret = await func(...args);
					await write_op(ret);
					await write_op(Return);
				}
				else if (opcode == 4) {
					const res = stack.pop();
					return res;
				}
			}
			await yiield();
		}
	}

	// Stub out the exports:
	const ret = {};
	for (const name of export_names) {
		ret[name] = async function stub(...args) {
			const send_queue = args.reverse();
			const func_idx = export_names.indexOf(name);
			send_queue.push(func_idx);
			send_queue.push(Call);
			return await vm_exec(send_queue);
		};
	}

	return ret;
}

export async function worker_entry(un_stubbed = {}) {
	const { data: { sab1, sab2, import_names, module_url }} = await new Promise(res => self.addEventListener('message', res, {once: true}));

	const {lock, inst, inst_dv, data, stack} = vm_state(sab1, sab2);
	let ip = 0;

	// Stub out the imports
	const env = un_stubbed;
	for (const name of import_names) { make_stub(name); }

	const { instance } = await WebAssembly.instantiateStreaming(fetch(module_url), { env });
	const export_names = Object.keys(instance.exports);
	const mem = instance.exports.memory; // TODO: Memory read / write


	function yiield() {
		inst.fill(0, ip);
		Atomics.store(lock, 0, 0);
		Atomics.notify(lock, 0, 1);
		Atomics.wait(lock, 0, 0);
		ip = 0;
	}

	// Synchronous execution in the worker
	function vm_exec(send_queue = []) {
		let ip = 0;
		function write_op(op) {
			if (typeof op == 'boolean') op = Number(op);
			if (typeof op == 'number') {
				if (ip + 9 >= inst.byteLength) yiield();
				inst[ip++] = 1;
				inst_dv.setFloat64(ip, op);
				ip += 8;
			}
			else if (typeof op == 'bigint') {
				if (ip + 9 >= inst.byteLength) yiield();
				inst[ip++] = 2;
				inst_dv.setBigInt64(ip, op);
				ip += 8;
			}
			else if (op == Call) {
				if (ip >= inst.byteLength) yiield();
				inst[ip++] = 3;
			}
			else if (op == Return) {
				if (ip >= inst.byteLength) yiield();
				inst[ip++] = 4;
			}
		}
		for (let op of send_queue) {
			write_op(op);
		}

		while (1) {
			while (ip < inst.byteLength) {
				const opcode = inst[ip++];
				if (opcode == 0) { break; }
				else if (opcode == 1) {
					stack.push(inst_dv.getFloat64(ip));
					ip += 8;
				}
				else if (opcode == 2) {
					stack.push(inst_dv.getBigInt64(ip));
					ip += 8;
				}
				else if (opcode == 3) {
					const func_idx = stack.pop();
					const func_name = export_names[func_idx];
					const func = instance.exports[func_name];
					const args = [];
					for (let i = 0; i < func.length; ++i) { args.push(stack.pop()); }
					const ret = func(...args);
					write_op(ret);
					write_op(Return);
				}
				else if (opcode == 4) {
					const res = stack.pop();
					return res;
				}
			}
			yiield();
		}
	}

	// Synchronous stubs for inside the worker:
	function make_stub(name) {
		env[name] = function stub(...args) {
			const send_queue = args.reverse();
			const func_idx = import_names.indexOf(name);
			send_queue.push(func_idx);
			send_queue.push(Call);
			return vm_exec(send_queue);
		};
	}

	// Pass out the exports:
	postMessage({ export_names });

	vm_exec();
}
