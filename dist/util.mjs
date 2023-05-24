export class OutOfMemError extends Error {
	constructor() {
		super("Out of Memory");
	}
}

export function is_promise(val) {
	return ['object', 'function'].includes(typeof val) && typeof val?.then == 'function';
}

export class Trait {
	constructor(description) {
		this.symbol = Symbol(description);
	}
	[Symbol.toPrimitive]() {
		return this.symbol;
	}
	get [Symbol.toStringTag]() {
		return `Trait(${this.symbol.description})`;
	}
	[Symbol.hasInstance](target) {
		return typeof target == 'object' && target !== null && target[this.symbol] !== undefined;
	}
}
