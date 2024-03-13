export class Lines extends TransformStream {
	constructor() {
		let buffer = '';
		super({
			transform(chunk, controller) {
				buffer += chunk;
				const reg = /(.*)\r?\n/g;
				let res;
				let i = 0;
				while ((res = reg.exec(buffer))) {
					controller.enqueue(res[1]);
					i = reg.lastIndex;
				}
				buffer = buffer.slice(i);
			},
			flush(controller) {
				if (buffer) controller.enqueue(buffer);
			}
		})
	}
}
