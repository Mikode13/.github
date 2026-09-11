#!/usr/bin/env node
// A fake `gh` binary for offline testing of scripts that shell out to the real CLI.
// CommonJS deliberately: this file gets copied to an extensionless `gh` executable on a
// test's PATH, and an extensionless script defaults to CommonJS without needing a
// sibling package.json to declare a module type.
//
// Configured entirely through environment variables so each test can script a sequence
// of canned responses and later inspect exactly how it was called.
//
// FAKE_GH_RESPONSES: JSON array of { status?: number, body?: unknown }, consumed in call
//   order (one entry per invocation of `gh`).
// FAKE_GH_CALL_INDEX_FILE: path to a counter file this script increments per call, so
//   independent process invocations share call-order state.
// FAKE_GH_LOG: path to a file this script appends one JSON-encoded argv array to, per
//   call, so a test can assert on the exact arguments used (e.g. `--method GET`).

const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');

const argv = process.argv.slice(2);

// Optional recording for tests of atomic GitHub mutations; real credentials are never used.
if (process.env.FAKE_GH_INPUT_LOG && argv.includes('--input')) {
	appendFileSync(
		process.env.FAKE_GH_INPUT_LOG,
		`${readFileSync(argv[argv.indexOf('--input') + 1], 'utf8')}\n`,
	);
}

if (process.env.FAKE_GH_LOG) {
	appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify(argv)}\n`);
}

const responses = JSON.parse(process.env.FAKE_GH_RESPONSES ?? '[]');
const callIndexFile = process.env.FAKE_GH_CALL_INDEX_FILE;
let callIndex = 0;

if (callIndexFile) {
	try {
		callIndex = Number(readFileSync(callIndexFile, 'utf8'));
	} catch {
		callIndex = 0;
	}
}

const response = responses[callIndex] ?? { status: 1, body: { message: 'no scripted response' } };

if (callIndexFile) {
	writeFileSync(callIndexFile, String(callIndex + 1));
}

if (response.status && response.status !== 0) {
	process.stderr.write(`fake gh: scripted failure for call ${callIndex}\n`);
	process.exit(response.status);
}

process.stdout.write(JSON.stringify(response.body ?? {}));
