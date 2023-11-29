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
		return target?.[this] !== undefined;
	}
}

export function is_safe(int) {
	return (BigInt(Number.MIN_SAFE_INTEGER) < int) &&
		(int < BigInt(Number.MAX_SAFE_INTEGER));
}
