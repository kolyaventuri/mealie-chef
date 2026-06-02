import path from 'node:path';
import process from 'node:process';
import 'dotenv/config';

export type AppConfig = {
	appTimeZone?: string;
	databasePath: string;
	mealieApiToken?: string;
	mealieBaseUrl?: string;
	port: number;
	staticRoot: string;
};

const normalizeUrl = (value?: string): string | undefined => {
	if (!value) {
		return undefined;
	}

	return value.replace(/\/+$/, '');
};

export const loadConfig = (): AppConfig => ({
	appTimeZone: process.env.APP_TIME_ZONE,
	databasePath:
		process.env.DATABASE_PATH ??
		path.join(process.cwd(), 'data', 'mealie-ipad-sync.sqlite'),
	mealieApiToken: process.env.MEALIE_API_TOKEN,
	mealieBaseUrl: normalizeUrl(process.env.MEALIE_BASE_URL),
	port: Number(process.env.PORT ?? 3100),
	staticRoot: path.join(process.cwd(), 'dist', 'client'),
});
