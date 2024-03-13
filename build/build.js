import { emptyDir } from 'std/fs/mod.ts';
import { build as step1 } from './sqlite_def.js';
import { build as step2 } from './copy.js';
import { build as step3 } from './compile.js';

await emptyDir('dist');

await Promise.all([
	step1(),
	step2(),
	step3()
]);
console.log('Build complete');
