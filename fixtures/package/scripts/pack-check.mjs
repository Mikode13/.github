import { spawnSync } from 'node:child_process';

const packageDirectory = new URL('../', import.meta.url);
const result = spawnSync('pnpm', ['pack', '--dry-run', '--json'], {
	cwd: packageDirectory,
	encoding: 'utf8',
});

if (result.status !== 0) {
	process.stderr.write(result.stderr);
	process.exit(result.status ?? 1);
}

const report = JSON.parse(result.stdout);
const files = new Set(report.files.map(file => file.path));
const requiredFiles = ['LICENSE', 'README.md', 'dist/index.d.ts', 'dist/index.js', 'package.json'];

for (const requiredFile of requiredFiles) {
	if (!files.has(requiredFile)) {
		throw new Error(`Package is missing required file: ${requiredFile}`);
	}
}

for (const file of files) {
	if (file.startsWith('src/') || file.startsWith('scripts/') || file.startsWith('tests/')) {
		throw new Error(`Package contains development-only file: ${file}`);
	}
}
