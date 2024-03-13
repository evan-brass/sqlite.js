import { emptyDir } from 'std/fs/mod.ts';
import { build as step1 } from './sqlite_def.js';
import { build as step3 } from './compile.js';

await emptyDir('src/dist');

await Promise.all([
	step1(),
	step3()
]);
console.log('Build complete');
