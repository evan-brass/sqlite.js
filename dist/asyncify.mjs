export async function instantiateStreaming(source, imports, {stack_size = 1024} = {}) {
	const module = WebAssembly.compileStreaming(source);

	const import_defs = WebAssembly.Module.imports(module);
	const export_defs = WebAssembly.Module.exports(module);

	const wrapped_imports = {};
	for (const {module, name, kind} of import_defs) {
		wrapped_imports[module] ??= {};
		wrapped_imports[module][name] = import_stub.bind(undefined, module, name);
	}

	const { instance } = WebAssembly.instantiate(module, wrapped_imports);

	const stacks = [];
	function allocate_stack() {
		const ptr = instance.exports.malloc(stack_size);

	}

	function import_stub(module, name, ...args) {
		
	}
}

export default async function asyncify(source, imports, { stack_size, stack_count } = {}) {
	if (!(source instanceof WebAssembly.Module)) {
		source = await WebAssembly.compileStreaming(source);
	}
	const import_defs = WebAssembly.Module.imports(source);
	const export_defs = WebAssembly.Module.exports(source);

	const wrapped_imports = {};
	for (const {kind, module, name} of import_defs) {
		wrapped_imports[module] ??= {};
		if (kind == 'function') {
			wrapped_imports[module][name] = function wrapper(...args) {

			};
		} else {
			wrapped_imports[module][name] = imports[module][name];
		}
	}

}



/**
 * Copyright 2019 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Put `__asyncify_data` somewhere at the start.
// This address is pretty hand-wavy and we might want to make it configurable in future.
// See https://github.com/WebAssembly/binaryen/blob/6371cf63687c3f638b599e086ca668c04a26cbbb/src/passes/Asyncify.cpp#L106-L113
// for structure details.
export const DATA_ADDR = 16;
// Place actual data right after the descriptor (which is 2 * sizeof(i32) = 8 bytes).
const DATA_START = DATA_ADDR + 8;
// End data at 1024 bytes. This is where the unused area by Clang ends and real stack / data begins.
// Because this might differ between languages and parameters passed to wasm-ld, ideally we would
// use `__stack_pointer` here, but, sadly, it's not exposed via exports yet.
const DATA_END = 1024;

const WRAPPED_EXPORTS = new WeakMap();

const State = {
  None: 0,
  Unwinding: 1,
  Rewinding: 2
};

function isPromise(obj) {
  return (
    !!obj &&
    (typeof obj === 'object' || typeof obj === 'function') &&
    typeof obj.then === 'function'
  );
}

function proxyGet(obj, transform) {
  return new Proxy(obj, {
    get: (obj, name) => transform(obj[name])
  });
}

class Asyncify {
  constructor() {
    this.value = undefined;
    this.exports = null;
  }

  getState() {
    return this.exports.asyncify_get_state();
  }

  assertNoneState() {
    let state = this.getState();
    if (state !== State.None) {
      throw new Error(`Invalid async state ${state}, expected 0.`);
    }
  }

  wrapImportFn(fn) {
    return (...args) => {
      if (this.getState() === State.Rewinding) {
        this.exports.asyncify_stop_rewind();
        return this.value;
      }
      this.assertNoneState();
      let value = fn(...args);
      if (!isPromise(value)) {
        return value;
      }
      this.exports.asyncify_start_unwind(DATA_ADDR);
      this.value = value;
    };
  }

  wrapModuleImports(module) {
    return proxyGet(module, value => {
      if (typeof value === 'function') {
        return this.wrapImportFn(value);
      }
      return value;
    });
  }

  wrapImports(imports) {
    if (imports === undefined) return;

    return proxyGet(imports, (moduleImports = Object.create(null)) =>
      this.wrapModuleImports(moduleImports)
    );
  }

  wrapExportFn(fn) {
    let newExport = WRAPPED_EXPORTS.get(fn);

    if (newExport !== undefined) {
      return newExport;
    }
    newExport = (...args) => {
      this.assertNoneState();

      let result = fn(...args);
	  if (this.getState() === State.Unwinding) {
		result = (async () => {
			while (this.getState() === State.Unwinding) {
				this.exports.asyncify_stop_unwind();
				this.value = await this.value;
				this.assertNoneState();
				this.exports.asyncify_start_rewind(DATA_ADDR);
				result = fn();
			}
		
			this.assertNoneState();

			return result;
		})();
	} else {
		this.assertNoneState();
	}
      return result;
    };

    WRAPPED_EXPORTS.set(fn, newExport);

    return newExport;
  }

  wrapExports(exports) {
    let newExports = Object.create(null);

    for (let exportName in exports) {
      let value = exports[exportName];
      if (typeof value === 'function' && !exportName.startsWith('asyncify_')) {
        value = this.wrapExportFn(value);
      }
      Object.defineProperty(newExports, exportName, {
        enumerable: true,
        value
      });
    }

    WRAPPED_EXPORTS.set(exports, newExports);

    return newExports;
  }

  init(instance, imports) {
    const { exports } = instance;

    const memory = exports.memory || (imports.env && imports.env.memory);

    new Int32Array(memory.buffer, DATA_ADDR).set([DATA_START, DATA_END]);

    this.exports = this.wrapExports(exports);

    Object.setPrototypeOf(instance, Instance.prototype);
  }
}

export class Instance extends WebAssembly.Instance {
  constructor(module, imports) {
    let state = new Asyncify();
    super(module, state.wrapImports(imports));
    state.init(this, imports);
  }

  get exports() {
    return WRAPPED_EXPORTS.get(super.exports);
  }
}

Object.defineProperty(Instance.prototype, 'exports', { enumerable: true });

export async function instantiate(source, imports) {
  let state = new Asyncify();
  let result = await WebAssembly.instantiate(
    source,
    state.wrapImports(imports)
  );
  state.init(
    result instanceof WebAssembly.Instance ? result : result.instance,
    imports
  );
  return result;
}

export async function instantiateStreaming(source, imports) {
  let state = new Asyncify();
  let result = await WebAssembly.instantiateStreaming(
    source,
    state.wrapImports(imports)
  );
  state.init(result.instance, imports);
  return result;
}
