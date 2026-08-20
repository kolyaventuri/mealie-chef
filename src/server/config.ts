import path from 'node:path';
import process from 'node:process';
import 'dotenv/config';

export type AppConfig = {
	appTimeZone?: string;
	databasePath: string;
	mealieApiToken?: string;
	mealieBaseUrl?: string;
	openAiApiKey?: string;
	openAiRecipeModel: string;
	openAiRecipeReasoningEffort:
		| 'high'
		| 'low'
		| 'max'
		| 'medium'
		| 'none'
		| 'xhigh';
	port: number;
	sessionMaxAgeMs: number;
	staticRoot: string;
};

const defaultSessionMaxAgeHours = 6;
const millisecondsPerHour = 60 * 60 * 1000;
const defaultOpenAiRecipeModel = 'gpt-5.6-luna';
const defaultOpenAiReasoningEffort = 'medium' as const;

const normalizeUrl = (value?: string): string | undefined => {
	if (!value) {
		return undefined;
	}

	return value.replace(/\/+$/, '');
};

const parseSessionMaxAgeMs = (value?: string): number => {
	const hours =
		value === undefined ? defaultSessionMaxAgeHours : Number.parseFloat(value);

	return Number.isFinite(hours) && hours >= 0
		? hours * millisecondsPerHour
		: defaultSessionMaxAgeHours * millisecondsPerHour;
};

const parseReasoningEffort = (
	value?: string,
): AppConfig['openAiRecipeReasoningEffort'] => {
	if (
		value === 'high' ||
		value === 'low' ||
		value === 'max' ||
		value === 'medium' ||
		value === 'none' ||
		value === 'xhigh'
	) {
		return value;
	}

	return defaultOpenAiReasoningEffort;
};

export const loadConfig = (): AppConfig => ({
	appTimeZone: process.env.APP_TIME_ZONE,
	databasePath:
		process.env.DATABASE_PATH ??
		path.join(process.cwd(), 'data', 'mealie-ipad-sync.sqlite'),
	mealieApiToken: process.env.MEALIE_API_TOKEN,
	mealieBaseUrl: normalizeUrl(process.env.MEALIE_BASE_URL),
	openAiApiKey: process.env.OPENAI_API_KEY,
	openAiRecipeModel: process.env.OPENAI_RECIPE_MODEL?.trim()
		? process.env.OPENAI_RECIPE_MODEL.trim()
		: defaultOpenAiRecipeModel,
	openAiRecipeReasoningEffort: parseReasoningEffort(
		process.env.OPENAI_RECIPE_REASONING_EFFORT,
	),
	port: Number(process.env.PORT ?? 3100),
	sessionMaxAgeMs: parseSessionMaxAgeMs(process.env.SESSION_MAX_AGE_HOURS),
	staticRoot: path.join(process.cwd(), 'dist', 'client'),
});
