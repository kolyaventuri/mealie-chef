import type {ISODate} from './types';

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
	day: '2-digit',
	month: '2-digit',
	year: 'numeric',
});

export const toISODate = (date: Date): ISODate =>
	dateFormatter.format(date) as ISODate;

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
): {start: ISODate; end: ISODate; today: ISODate} => {
	const start = startOfWeek(now);
	const end = addDays(start, 6);

	return {
		end: toISODate(end),
		start: toISODate(start),
		today: toISODate(now),
	};
};

export const getDateRange = (start: ISODate, end: ISODate): ISODate[] => {
	const dates: ISODate[] = [];
	let cursor = parseISODate(start);
	const last = parseISODate(end);

	while (cursor <= last) {
		dates.push(toISODate(cursor));
		cursor = addDays(cursor, 1);
	}

	return dates;
};
