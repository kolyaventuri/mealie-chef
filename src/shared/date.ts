import type {ISODate} from './types';

const dateFormatterOptions = {
	day: '2-digit',
	month: '2-digit',
	year: 'numeric',
} as const;

const formatUTCDate = (date: Date): ISODate =>
	[
		date.getUTCFullYear(),
		String(date.getUTCMonth() + 1).padStart(2, '0'),
		String(date.getUTCDate()).padStart(2, '0'),
	].join('-') as ISODate;

const parseUTCDate = (value: ISODate): Date => {
	const [year, month, day] = value.split('-').map(Number);

	return new Date(Date.UTC(year, month - 1, day));
};

const addDaysToISODate = (date: ISODate, days: number): ISODate => {
	const next = parseUTCDate(date);
	next.setUTCDate(next.getUTCDate() + days);

	return formatUTCDate(next);
};

export const toISODate = (date: Date, timeZone?: string): ISODate => {
	const parts = new Intl.DateTimeFormat('en-US', {
		...dateFormatterOptions,
		...(timeZone ? {timeZone} : {}),
	}).formatToParts(date);
	const values = Object.fromEntries(
		parts.map((part) => [part.type, part.value]),
	) as Record<string, string>;

	return `${values.year}-${values.month}-${values.day}` as ISODate;
};

export const parseISODate = (value: string): Date => {
	const [year, month, day] = value.split('-').map(Number);

	return new Date(year, month - 1, day);
};

export const addDays = (date: Date, days: number): Date => {
	const next = new Date(date);
	next.setDate(next.getDate() + days);

	return next;
};

export const startOfWeek = (date: Date): Date => {
	const start = new Date(date);
	const day = start.getDay();
	start.setDate(start.getDate() - day);
	start.setHours(0, 0, 0, 0);

	return start;
};

export const getWeekRange = (
	now = new Date(),
	timeZone?: string,
): {start: ISODate; end: ISODate; today: ISODate} => {
	const today = toISODate(now, timeZone);
	const start = addDaysToISODate(today, -parseUTCDate(today).getUTCDay());

	return {
		end: addDaysToISODate(start, 6),
		start,
		today,
	};
};

export const getDateRange = (start: ISODate, end: ISODate): ISODate[] => {
	const dates: ISODate[] = [];
	let cursor = start;

	while (cursor <= end) {
		dates.push(cursor);
		cursor = addDaysToISODate(cursor, 1);
	}

	return dates;
};
