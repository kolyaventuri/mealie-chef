import {describe, expect, it} from 'vitest';
import {getDateRange, getWeekRange} from './date';

describe('date helpers', () => {
	it('builds a Sunday-to-Saturday week range', () => {
		expect(getWeekRange(new Date(2026, 5, 2))).toEqual({
			end: '2026-06-06',
			start: '2026-05-31',
			today: '2026-06-02',
		});
	});

	it('enumerates inclusive date ranges', () => {
		expect(getDateRange('2026-06-01', '2026-06-03')).toEqual([
			'2026-06-01',
			'2026-06-02',
			'2026-06-03',
		]);
	});
});
