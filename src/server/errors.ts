export class HttpError extends Error {
	readonly statusCode: number;

	constructor(statusCode: number, message: string) {
		super(message);
		this.name = 'HttpError';
		this.statusCode = statusCode;
	}
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

export const getString = (value: unknown): string | undefined =>
	typeof value === 'string' && value.trim() ? value : undefined;
