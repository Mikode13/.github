import { describe, expect, it } from 'vitest';

import { add } from '../../src/index.js';

describe('add', () => {
	it('returns the sum of two numbers', () => {
		expect(add(20, 22)).toBe(42);
	});
});
