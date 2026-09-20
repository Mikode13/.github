/**
 * Collects the findings earlier reviews published on this pull request, so the reviewer can
 * recheck each one instead of depending on discovering it again. It runs in the analysis job
 * with a read-only token, and whether a person closed a conversation is deliberately left out:
 * that is a decision about the pull request, not evidence about the code.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createGitHub, readReviewState } from './review-state.mjs';

const environment = key => {
	const value = process.env[key];
	if (!value) throw new Error(`${key} is required`);
	return value;
};

const { earlier } = await readReviewState(createGitHub(environment('GITHUB_TOKEN')), {
	repository: environment('REPOSITORY'),
	pullNumber: environment('PR_NUMBER'),
});

writeFileSync(
	join(environment('EVIDENCE_DIR'), 'earlier-findings.json'),
	JSON.stringify(earlier, null, 2),
);
console.log(`Earlier findings to recheck: ${earlier.length}.`);
