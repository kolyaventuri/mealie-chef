import {Buffer} from 'node:buffer';
import fs from 'node:fs';
import process from 'node:process';
import {clearInterval, setInterval} from 'node:timers';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import fastifyWebsocket from '@fastify/websocket';
import cors from '@fastify/cors';
import fastify, {type FastifyInstance, type FastifyRequest} from 'fastify';
import {getDateRange, getWeekRange} from '../shared/date';
import type {
	ClientSessionMessage,
	CookingSession,
	ISODate,
	MealPlanEntry,
	ServerSessionMessage,
	SessionMutation,
} from '../shared/types';
import {
	type RecipeImportMode,
	type RecipeImportIngredientParsing,
	type RecipeImportParseResponse,
	type SchemaOrgRecipe,
	validateSchemaOrgRecipe,
} from '../shared/recipe-import';
import type {AppConfig} from './config';
import {HttpError, isRecord} from './errors';
import {
	buildMealieRecipeUrl,
	MealieClient,
	type ParsedMealieIngredient,
} from './mealie-client';
import {
	OpenAiRecipeParser,
	recipeParserModeFromValue,
	type IngredientParser,
	type RecipeImageInput,
	type RecipeParser,
	type RecipeParserInput,
	type RecipeUrlSource,
} from './recipe-parser';
import {
	hasMealieId,
	refineIngredientsWithLlm,
	summarizeParsedIngredients,
	toLlmParsedMealieIngredient,
} from './ingredient-parser';
import {fetchRecipeSource} from './recipe-source';
import {SessionStore} from './session-store';

type WebSocketLike = {
	readyState: number;
	send(data: string): void;
	on(
		event: 'close' | 'message',
		listener: (data?: Uint8Array | string) => void,
	): void;
};

export type AppDependencies = {
	config: AppConfig;
	ingredientParser?: IngredientParser;
	mealieClient?: MealieClient;
	recipeParser?: RecipeParser;
	sessionStore?: SessionStore;
	sourceFetcher?: (url: string) => Promise<RecipeUrlSource>;
	websocketHeartbeatIntervalMs?: number;
};

const openState = 1;
const defaultWebsocketHeartbeatIntervalMs = 25_000;
const parserRateLimitWindowMs = 15 * 60 * 1000;
const parserRateLimitMaxRequests = 5;
const parserMaxTextLength = 100_000;
const parserMaxImages = 8;
const parserMaxImageBytes = 10 * 1024 * 1024;
const parserMaxRequestBytes = 32 * 1024 * 1024;

const serialize = (message: ServerSessionMessage): string =>
	JSON.stringify(message);

const bodyAsRecord = (body: unknown): Record<string, unknown> =>
	isRecord(body) ? body : {};

const parseSessionMutation = (value: unknown): SessionMutation => {
	if (!isRecord(value) || typeof value.type !== 'string') {
		throw new HttpError(400, 'Session patch is invalid.');
	}

	if (
		value.type === 'set-active-step' &&
		typeof value.activeStepIndex === 'number'
	) {
		return {
			activeStepIndex: value.activeStepIndex,
			type: value.type,
		};
	}

	if (
		value.type === 'set-ingredient-checked' &&
		typeof value.ingredientKey === 'string' &&
		typeof value.checked === 'boolean'
	) {
		return {
			checked: value.checked,
			ingredientKey: value.ingredientKey,
			type: value.type,
		};
	}

	if (
		value.type === 'set-servings' &&
		(value.servings === null || typeof value.servings === 'number')
	) {
		return {type: value.type, servings: value.servings};
	}

	if (
		value.type === 'adjust-servings' &&
		(value.change === -1 || value.change === 1) &&
		typeof value.defaultServings === 'number'
	) {
		return {
			type: value.type,
			change: value.change,
			defaultServings: value.defaultServings,
		};
	}

	throw new HttpError(400, 'Session patch is invalid.');
};

const groupPlansByDate = (
	entries: MealPlanEntry[],
	start: ISODate,
	end: ISODate,
	today: ISODate,
) => {
	const byDate = new Map<string, MealPlanEntry[]>();

	for (const entry of entries) {
		byDate.set(entry.date, [...(byDate.get(entry.date) ?? []), entry]);
	}

	return getDateRange(start, end).map((date) => ({
		date,
		entries: byDate.get(date) ?? [],
		isToday: date === today,
	}));
};

const sendToSession = (
	clients: Map<string, Set<WebSocketLike>>,
	sessionId: string,
	message: ServerSessionMessage,
): void => {
	const sockets = clients.get(sessionId);

	if (!sockets) {
		return;
	}

	const payload = serialize(message);

	for (const socket of sockets) {
		if (socket.readyState === openState) {
			socket.send(payload);
		}
	}
};

const sendPresence = (
	clients: Map<string, Set<WebSocketLike>>,
	sessionId: string,
): void => {
	sendToSession(clients, sessionId, {
		count: clients.get(sessionId)?.size ?? 0,
		type: 'presence',
	});
};

const sendToSockets = (
	sockets: Set<WebSocketLike>,
	message: ServerSessionMessage,
): void => {
	const payload = serialize(message);

	for (const socket of sockets) {
		if (socket.readyState === openState) {
			socket.send(payload);
		}
	}
};

const sendGlobalPresence = (sockets: Set<WebSocketLike>): void => {
	sendToSockets(sockets, {
		count: sockets.size,
		type: 'presence',
	});
};

const sendHeartbeat = (
	clients: Map<string, Set<WebSocketLike>>,
	globalClients: Set<WebSocketLike>,
): void => {
	const message: ServerSessionMessage = {type: 'heartbeat'};

	sendToSockets(globalClients, message);

	for (const sockets of clients.values()) {
		sendToSockets(sockets, message);
	}
};

const isApiOrRealtimePath = (url: string): boolean =>
	url === '/ws' ||
	url.startsWith('/api/') ||
	url.startsWith('/import/') ||
	url.startsWith('/ws/');

const getSessionId = (requestParameters: unknown): string => {
	if (
		!isRecord(requestParameters) ||
		typeof requestParameters.sessionId !== 'string'
	) {
		throw new HttpError(400, 'Session id is required.');
	}

	return requestParameters.sessionId;
};

const getRecipeSlug = (body: unknown): string => {
	const record = bodyAsRecord(body);

	if (typeof record.recipeSlug === 'string' && record.recipeSlug.trim()) {
		return record.recipeSlug;
	}

	throw new HttpError(400, 'recipeSlug is required.');
};

type RecipeImportFields = {
	images: RecipeImageInput[];
	mode?: RecipeImportMode;
	text?: string;
	url?: string;
};

type ValidatedRecipeImportFields =
	| {mode: 'url'; url: string}
	| {mode: 'text'; text: string}
	| {images: RecipeImageInput[]; mode: 'images'};

const acceptedImageMimeTypes = new Set<RecipeImageInput['mimeType']>([
	'image/jpeg',
	'image/png',
	'image/webp',
]);

const parseImportMode = (value: unknown): RecipeImportMode => {
	const mode = recipeParserModeFromValue(value);

	if (!mode) {
		throw new HttpError(400, 'Choose a URL, text, or screenshot import mode.');
	}

	return mode;
};

const hasImportText = (value: string | undefined): boolean =>
	(value?.trim().length ?? 0) > 0;

const validateImportFields = (
	fields: RecipeImportFields,
): ValidatedRecipeImportFields => {
	const mode = parseImportMode(fields.mode);

	if (mode === 'url') {
		const url = fields.url?.trim();

		if (!url || hasImportText(fields.text) || fields.images.length > 0) {
			throw new HttpError(400, 'URL import accepts only one recipe URL.');
		}

		if (url.length > 4096) {
			throw new HttpError(413, 'The recipe URL is too long.');
		}

		return {mode, url};
	}

	if (mode === 'text') {
		const text = fields.text?.trim();

		if (!text || hasImportText(fields.url) || fields.images.length > 0) {
			throw new HttpError(400, 'Text import accepts only pasted recipe text.');
		}

		if (text.length > parserMaxTextLength) {
			throw new HttpError(413, 'The pasted recipe text is too long.');
		}

		return {mode, text};
	}

	if (hasImportText(fields.url) || hasImportText(fields.text)) {
		throw new HttpError(400, 'Screenshot import accepts only recipe images.');
	}

	if (fields.images.length === 0) {
		throw new HttpError(400, 'Add at least one recipe screenshot.');
	}

	if (fields.images.length > parserMaxImages) {
		throw new HttpError(
			413,
			`Upload no more than ${parserMaxImages} screenshots.`,
		);
	}

	return {images: fields.images, mode};
};

const parseJsonImportFields = (body: unknown): RecipeImportFields => {
	const record = bodyAsRecord(body);
	const images: RecipeImageInput[] = [];

	return {
		images,
		mode: recipeParserModeFromValue(record.mode),
		text: typeof record.text === 'string' ? record.text : undefined,
		url: typeof record.url === 'string' ? record.url : undefined,
	};
};

const parseMultipartImportFields = async (
	request: FastifyRequest,
): Promise<RecipeImportFields> => {
	const fields: RecipeImportFields = {images: []};
	let totalImageBytes = 0;

	try {
		for await (const part of request.parts()) {
			if (part.type === 'field') {
				if (part.fieldname === 'mode' && typeof part.value === 'string') {
					fields.mode = recipeParserModeFromValue(part.value);
				}

				if (part.fieldname === 'url' && typeof part.value === 'string') {
					fields.url = part.value;
				}

				if (part.fieldname === 'text' && typeof part.value === 'string') {
					fields.text = part.value;
				}

				continue;
			}

			if (part.fieldname !== 'images') {
				throw new HttpError(
					400,
					'Screenshot uploads must use the images field.',
				);
			}

			if (
				!acceptedImageMimeTypes.has(
					part.mimetype as RecipeImageInput['mimeType'],
				)
			) {
				throw new HttpError(415, 'Use PNG, JPEG, or WebP recipe screenshots.');
			}

			const data = await part.toBuffer();
			totalImageBytes += data.byteLength;

			if (totalImageBytes > parserMaxRequestBytes) {
				throw new HttpError(
					413,
					'The screenshot upload must be 32 MB or smaller.',
				);
			}

			if (data.byteLength > parserMaxImageBytes) {
				throw new HttpError(
					413,
					'Each recipe screenshot must be 10 MB or smaller.',
				);
			}

			fields.images.push({
				data,
				mimeType: part.mimetype as RecipeImageInput['mimeType'],
			});
		}
	} catch (error) {
		if (error instanceof HttpError) {
			throw error;
		}

		throw new HttpError(
			413,
			'Each screenshot must be 10 MB or smaller and the upload must be 32 MB or smaller.',
		);
	}

	return fields;
};

const clientAddress = (request: {ip?: string}): string =>
	request.ip ?? 'unknown';

const recipeImportErrorCode = (error: unknown): string => {
	if (error instanceof HttpError) {
		return `http_${error.statusCode}`;
	}

	if (isRecord(error) && typeof error.statusCode === 'number') {
		return `http_${error.statusCode}`;
	}

	return error instanceof Error ? error.name : 'unknown_error';
};

const recipeImportErrorMetadata = (error: unknown): Record<string, unknown> => {
	if (!isRecord(error)) {
		return {};
	}

	const usage = isRecord(error.usage) ? error.usage : undefined;
	const inputTokens =
		typeof usage?.inputTokens === 'number' ? usage.inputTokens : undefined;
	const outputTokens =
		typeof usage?.outputTokens === 'number' ? usage.outputTokens : undefined;

	const metadata: Record<string, unknown> = {};

	for (const field of [
		'openaiErrorCode',
		'openaiErrorName',
		'openaiErrorParam',
		'openaiErrorReason',
		'openaiErrorType',
	]) {
		if (typeof error[field] === 'string') {
			metadata[field] = error[field];
		}
	}

	if (typeof error.openaiStatus === 'number') {
		metadata.openaiStatus = error.openaiStatus;
	}

	if (typeof error.openaiRequestId === 'string') {
		metadata.openaiRequestId = error.openaiRequestId;
	}

	if (typeof inputTokens === 'number') {
		metadata.openaiInputTokens = inputTokens;
	}

	if (typeof outputTokens === 'number') {
		metadata.openaiOutputTokens = outputTokens;
	}

	return metadata;
};

const logRecipeImportFailure = ({
	error,
	mode,
	request,
	stage,
	startedAt,
}: {
	error: unknown;
	mode?: RecipeImportMode;
	request: FastifyRequest;
	stage: string;
	startedAt: number;
}): void => {
	request.log.warn(
		{
			...recipeImportErrorMetadata(error),
			errorCode: recipeImportErrorCode(error),
			elapsedMs: Date.now() - startedAt,
			mode,
			requestId: request.id,
			stage,
		},
		'recipe import failed',
	);
};

const ingredientParseFallbackWarning =
	'Mealie ingredient parsing was unavailable, so the original ingredient text was kept.';

const ingredientUpdateFallbackWarning =
	'Mealie parsed the ingredients, but could not save the structured ingredient data. The recipe was still added with its original ingredient text.';

const ingredientLlmFallbackWarning =
	'Mealie parsed the ingredients, but the optional LLM cleanup was unavailable. Any unmatched ingredient references were kept as entered.';

const parseIngredientsForImport = async ({
	ingredientParser,
	mealie,
	recipe,
	request,
}: {
	ingredientParser?: IngredientParser;
	mealie: MealieClient;
	recipe: SchemaOrgRecipe;
	request: FastifyRequest;
}): Promise<{
	parsedIngredients?: ParsedMealieIngredient[];
	summary: RecipeImportIngredientParsing;
}> => {
	try {
		let parsedIngredients = await mealie.parseIngredients(
			recipe.recipeIngredient,
		);
		let llmParsedCount = 0;
		let warning: string | undefined;

		if (ingredientParser) {
			try {
				const refined = await refineIngredientsWithLlm({
					ingredientParser,
					mealie,
					parsedIngredients,
					recipe,
				});
				llmParsedCount = refined.llmParsedCount;
				parsedIngredients = refined.parsedIngredients;
			} catch (error) {
				warning = ingredientLlmFallbackWarning;
				request.log.warn(
					{
						errorCode: recipeImportErrorCode(error),
						ingredientCount: recipe.recipeIngredient.length,
						stage: 'llm_ingredient_parse_fallback',
					},
					'LLM ingredient cleanup unavailable; keeping Mealie ingredient parse',
				);
			}
		}

		const summary = summarizeParsedIngredients(
			parsedIngredients,
			llmParsedCount,
			warning,
		);

		request.log.info(
			{
				ingredientCount: summary.ingredientCount,
				mappedFoodCount: summary.mappedFoodCount,
				mappedUnitCount: summary.mappedUnitCount,
				stage: 'mealie_ingredients_parsed',
			},
			'Mealie parsed recipe ingredients',
		);

		return {parsedIngredients, summary};
	} catch (error) {
		if (ingredientParser) {
			try {
				const llmResult = await ingredientParser.parseIngredients(
					recipe.recipeIngredient,
				);
				const parsedIngredients = llmResult.ingredients.map(
					(ingredient, index) =>
						toLlmParsedMealieIngredient(
							recipe.recipeIngredient[index],
							ingredient,
						),
				);

				return {
					parsedIngredients,
					summary: summarizeParsedIngredients(
						parsedIngredients,
						llmResult.ingredients.length,
					),
				};
			} catch (llmError) {
				request.log.warn(
					{
						errorCode: recipeImportErrorCode(llmError),
						ingredientCount: recipe.recipeIngredient.length,
						stage: 'llm_ingredient_parse_fallback_failed',
					},
					'LLM ingredient fallback also failed; keeping source ingredient text',
				);
			}
		}

		request.log.warn(
			{
				errorCode: recipeImportErrorCode(error),
				ingredientCount: recipe.recipeIngredient.length,
				stage: 'mealie_ingredient_parse_fallback',
			},
			'Mealie ingredient parsing unavailable; keeping source ingredient text',
		);

		return {
			summary: {
				ingredientCount: recipe.recipeIngredient.length,
				mappedFoodCount: 0,
				mappedUnitCount: 0,
				parsed: false,
				warning: ingredientParseFallbackWarning,
			},
		};
	}
};

export const createApp = async ({
	config,
	ingredientParser,
	mealieClient,
	recipeParser,
	sessionStore,
	sourceFetcher,
	websocketHeartbeatIntervalMs = defaultWebsocketHeartbeatIntervalMs,
}: AppDependencies): Promise<FastifyInstance> => {
	const app = fastify({
		bodyLimit: 32 * 1024 * 1024,
		trustProxy: config.trustedProxies ?? false,
		logger: {
			level: process.env.LOG_LEVEL ?? 'info',
		},
	});

	if (process.env.VITE_NODE_ENV === 'local') {
		await app.register(cors, {
			origin: true, // allow all origins
		});
	}

	const mealie =
		mealieClient ??
		new MealieClient({
			apiToken: config.mealieApiToken,
			baseUrl: config.mealieBaseUrl,
		});
	const defaultOpenAiParser = config.openAiApiKey
		? new OpenAiRecipeParser({
				apiKey: config.openAiApiKey,
				model: config.openAiRecipeModel,
				reasoningEffort: config.openAiRecipeReasoningEffort,
			})
		: undefined;
	const parser = recipeParser ?? defaultOpenAiParser;
	const ingredientParserForImport = ingredientParser ?? defaultOpenAiParser;
	const fetchSource = sourceFetcher ?? fetchRecipeSource;
	const store = sessionStore ?? new SessionStore(config.databasePath);
	const clients = new Map<string, Set<WebSocketLike>>();
	const globalClients = new Set<WebSocketLike>();
	const parserRateLimits = new Map<
		string,
		{count: number; startedAt: number}
	>();
	const getCurrentGlobalSession = (): CookingSession | undefined =>
		store.getGlobalSession({maxAgeMs: config.sessionMaxAgeMs});
	const websocketHeartbeatTimer =
		websocketHeartbeatIntervalMs > 0
			? setInterval(() => {
					sendHeartbeat(clients, globalClients);
				}, websocketHeartbeatIntervalMs)
			: undefined;

	websocketHeartbeatTimer?.unref();

	app.addHook('onClose', async () => {
		if (websocketHeartbeatTimer) {
			clearInterval(websocketHeartbeatTimer);
		}

		store.close();
	});

	app.setErrorHandler((error, request, reply) => {
		const errorStatusCode =
			isRecord(error) && typeof error.statusCode === 'number'
				? error.statusCode
				: undefined;
		const statusCode =
			error instanceof HttpError
				? error.statusCode
				: errorStatusCode !== undefined && errorStatusCode >= 400
					? errorStatusCode
					: 500;
		const message =
			statusCode === 500
				? 'Unexpected server error.'
				: error instanceof Error
					? error.message
					: 'Request failed.';

		if (statusCode === 500) {
			if (request.url.startsWith('/import/')) {
				request.log.error(
					{
						...recipeImportErrorMetadata(error),
						errorCode: recipeImportErrorCode(error),
						requestId: request.id,
					},
					'Unhandled recipe import error',
				);
			} else {
				app.log.error(error);
			}
		}

		const requestId = request.url.startsWith('/import/')
			? request.id
			: undefined;

		void reply.status(statusCode).send({
			message,
			...(requestId ? {requestId} : {}),
		});
	});

	await app.register(fastifyWebsocket);
	await app.register(fastifyMultipart, {
		limits: {
			files: parserMaxImages,
			fileSize: parserMaxImageBytes,
			fields: 3,
			parts: parserMaxImages + 3,
		},
	});

	app.get('/api/planner/week', async (request) => {
		const query = bodyAsRecord(request.query);
		const range = getWeekRange(new Date(), config.appTimeZone);
		const start = (
			typeof query.start === 'string' ? query.start : range.start
		) as ISODate;
		const end = (
			typeof query.end === 'string' ? query.end : range.end
		) as ISODate;
		const {today} = range;
		const [weekEntries, todayEntries] = await Promise.all([
			mealie.getWeekMealPlans(start, end),
			mealie.getTodayMealPlans().catch(() => []),
		]);
		const todayEntryIds = new Set(weekEntries.map((entry) => entry.id));

		for (const todayEntry of todayEntries) {
			if (!todayEntryIds.has(todayEntry.id)) {
				weekEntries.push(todayEntry);
			}
		}

		return {
			days: groupPlansByDate(weekEntries, start, end, today),
			end,
			start,
			today,
		};
	});

	app.get('/api/recipes', async (request) => {
		const query = bodyAsRecord(request.query);
		const search = typeof query.query === 'string' ? query.query : '';

		return {
			recipes: await mealie.searchRecipes(search),
		};
	});

	app.get('/api/recipes/:slug', async (request) => {
		if (!isRecord(request.params) || typeof request.params.slug !== 'string') {
			throw new HttpError(400, 'Recipe slug is required.');
		}

		return {
			recipe: await mealie.getRecipe(request.params.slug),
		};
	});

	app.get('/api/media-proxy', async (request, reply) => {
		const query = bodyAsRecord(request.query);

		if (
			typeof query.path !== 'string' ||
			!/^\/(?:api|media)\//.test(query.path)
		) {
			throw new HttpError(400, 'A token-safe Mealie media path is required.');
		}

		const response = await mealie.proxy(query.path);
		const contentType =
			response.headers.get('content-type') ?? 'application/octet-stream';
		const bytes = Buffer.from(await response.arrayBuffer());

		return reply.type(contentType).send(bytes);
	});

	// This handler has separate validation branches for the three mutually exclusive input modes.
	// eslint-disable-next-line complexity
	app.post('/import/parse', async (request, reply) => {
		const startedAt = Date.now();
		let mode: RecipeImportMode | undefined;
		let stage = 'configuration';

		request.log.info(
			{
				requestId: request.id,
				route: '/import/parse',
				stage: 'started',
			},
			'recipe import started',
		);

		try {
			if (!parser) {
				throw new HttpError(
					503,
					'Recipe importing is not configured. Set OPENAI_API_KEY on the server.',
				);
			}

			stage = 'rate_limit';
			const address = clientAddress(request);
			const now = Date.now();

			for (const [limitedAddress, limit] of parserRateLimits) {
				if (now - limit.startedAt >= parserRateLimitWindowMs) {
					parserRateLimits.delete(limitedAddress);
				}
			}

			const existingLimit = parserRateLimits.get(address);

			if (
				existingLimit &&
				now - existingLimit.startedAt < parserRateLimitWindowMs &&
				existingLimit.count >= parserRateLimitMaxRequests
			) {
				const retryAfterSeconds = Math.ceil(
					(existingLimit.startedAt + parserRateLimitWindowMs - now) / 1000,
				);
				const retryAfterMinutes = Math.ceil(retryAfterSeconds / 60);
				void reply.header('Retry-After', retryAfterSeconds);
				request.log.warn(
					{
						limit: parserRateLimitMaxRequests,
						requestCount: existingLimit.count,
						requestId: request.id,
						retryAfterSeconds,
						stage: 'rate_limit',
						windowSeconds: parserRateLimitWindowMs / 1000,
					},
					'recipe import local rate limit exceeded',
				);
				throw new HttpError(
					429,
					`Recipe import reached this server's limit of ${parserRateLimitMaxRequests} attempts per 15 minutes. Try again in ${retryAfterMinutes} ${retryAfterMinutes === 1 ? 'minute' : 'minutes'}.`,
				);
			}

			parserRateLimits.set(
				address,
				existingLimit && now - existingLimit.startedAt < parserRateLimitWindowMs
					? {
							count: existingLimit.count + 1,
							startedAt: existingLimit.startedAt,
						}
					: {count: 1, startedAt: now},
			);

			stage = 'input_validation';
			const contentType =
				typeof request.headers['content-type'] === 'string'
					? request.headers['content-type']
					: '';
			const fields = contentType.startsWith('multipart/form-data')
				? await parseMultipartImportFields(request)
				: parseJsonImportFields(request.body);
			const validated = validateImportFields(fields);
			mode = validated.mode;
			const inputStats =
				validated.mode === 'text'
					? {textLength: validated.text.length}
					: validated.mode === 'images'
						? {
								imageBytes: validated.images.reduce(
									(total, image) => total + image.data.byteLength,
									0,
								),
								imageCount: validated.images.length,
							}
						: {};

			request.log.info(
				{
					...inputStats,
					mode,
					requestId: request.id,
					stage: 'input_validated',
				},
				'recipe import input validated',
			);

			let parserInput: RecipeParserInput;
			let source: RecipeImportParseResponse['source'];

			if (validated.mode === 'url') {
				stage = 'source_fetch';
				const fetchedSource = await fetchSource(validated.url);

				request.log.info(
					{
						hasStructuredData: fetchedSource.jsonLd.length > 0,
						jsonLdCount: fetchedSource.jsonLd.length,
						requestId: request.id,
						stage: 'source_fetched',
						visibleTextLength: fetchedSource.visibleText.length,
					},
					'recipe page source fetched',
				);

				parserInput = {
					mode: 'url',
					source: fetchedSource,
				};
				source = {
					kind: 'url',
					url: fetchedSource.canonicalUrl,
				};
			} else if (validated.mode === 'text') {
				parserInput = validated;
				source = {kind: 'text'};
			} else {
				parserInput = validated;
				source = {kind: 'images'};
			}

			stage = 'openai_request';
			request.log.info(
				{
					mode,
					model: config.openAiRecipeModel,
					requestId: request.id,
					stage,
				},
				'recipe parser request started',
			);
			const parsed = await parser.parse(parserInput);

			request.log.info(
				{
					inputTokens: parsed.usage?.inputTokens,
					mode,
					openaiRequestId: parsed.requestId,
					outputTokens: parsed.usage?.outputTokens,
					requestId: request.id,
					reviewNoteCount: parsed.reviewNotes.length,
					stage: 'openai_response',
				},
				'recipe parser response received',
			);

			stage = 'draft_validation';
			const recipeWithSource =
				validated.mode === 'url' && !parsed.recipe.url
					? {...parsed.recipe, url: source.url}
					: parsed.recipe;
			const validation = validateSchemaOrgRecipe(recipeWithSource);

			if (!validation.recipe) {
				throw new HttpError(
					422,
					`The parsed recipe is incomplete: ${validation.errors.join(' ')}`,
				);
			}

			request.log.info(
				{
					elapsedMs: Date.now() - startedAt,
					mode,
					requestId: request.id,
					reviewNoteCount: parsed.reviewNotes.length,
					stage: 'draft_ready',
					warningCount: validation.warnings.length,
				},
				'recipe import draft ready for review',
			);

			return {
				recipe: validation.recipe,
				reviewNotes: parsed.reviewNotes,
				source,
				warnings: validation.warnings,
			} satisfies RecipeImportParseResponse;
		} catch (error) {
			logRecipeImportFailure({error, mode, request, stage, startedAt});
			throw error;
		}
	});

	app.post('/import/confirm', async (request) => {
		const startedAt = Date.now();
		let stage = 'draft_validation';
		let ingredientParsing: RecipeImportIngredientParsing | undefined;

		request.log.info(
			{
				requestId: request.id,
				route: '/import/confirm',
				stage: 'started',
			},
			'recipe import confirmation started',
		);

		try {
			const record = bodyAsRecord(request.body);
			const validation = validateSchemaOrgRecipe(record.recipe);

			if (!validation.recipe) {
				throw new HttpError(
					400,
					`The recipe draft is invalid: ${validation.errors.join(' ')}`,
				);
			}

			stage = 'mealie_context';
			if (!config.mealieBaseUrl || !mealie.configured) {
				throw new HttpError(
					503,
					'Mealie is not configured. Set MEALIE_BASE_URL and MEALIE_API_TOKEN.',
				);
			}

			stage = 'mealie_ingredient_parse';
			const parsedResult = await parseIngredientsForImport({
				ingredientParser: ingredientParserForImport,
				mealie,
				recipe: validation.recipe,
				request,
			});
			ingredientParsing = parsedResult.summary;

			const groupSlug = await mealie.getGroupSlug();
			stage = 'mealie_import';
			const slug = await mealie.importSchemaRecipe(validation.recipe);

			if (parsedResult.parsedIngredients) {
				stage = 'mealie_ingredient_update';

				try {
					await mealie.updateRecipeIngredients(
						slug,
						parsedResult.parsedIngredients,
					);
				} catch (error) {
					request.log.warn(
						{
							errorCode: recipeImportErrorCode(error),
							requestId: request.id,
							stage,
						},
						'Mealie structured ingredient update failed; keeping the imported recipe',
					);
					ingredientParsing = {
						...ingredientParsing,
						parsed: false,
						warning: ingredientUpdateFallbackWarning,
					};
				}
			}

			const mealieUrl = buildMealieRecipeUrl(
				config.mealieBaseUrl,
				groupSlug,
				slug,
			);

			request.log.info(
				{
					requestId: request.id,
					stage: 'mealie_imported',
				},
				'recipe sent to Mealie',
			);

			stage = 'verification';
			const importedRecipe = await mealie.getRecipe(slug);

			request.log.info(
				{
					elapsedMs: Date.now() - startedAt,
					requestId: request.id,
					stage: 'verified',
				},
				'Mealie recipe import verified',
			);

			return {
				ingredientParsing,
				mealieUrl,
				recipe: importedRecipe,
				slug,
			};
		} catch (error) {
			logRecipeImportFailure({error, request, stage, startedAt});
			throw error;
		}
	});

	app.post('/api/sessions', async (request) => {
		const recipeSlug = getRecipeSlug(request.body);
		const recipe = await mealie.getRecipe(recipeSlug);
		const session = store.createSession({
			servings: recipe.recipeServings,
			ingredientKeys: recipe.ingredients.map((ingredient) => ingredient.key),
			recipeName: recipe.name,
			recipeSlug: recipe.slug,
		});

		return {
			session,
		};
	});

	app.get('/api/global-session', async () => ({
		session: getCurrentGlobalSession() ?? null,
	}));

	app.post('/api/global-session', async (request) => {
		const recipeSlug = getRecipeSlug(request.body);
		const recipe = await mealie.getRecipe(recipeSlug);
		const session = store.createGlobalSession({
			servings: recipe.recipeServings,
			ingredientKeys: recipe.ingredients.map((ingredient) => ingredient.key),
			recipeName: recipe.name,
			recipeSlug: recipe.slug,
		});

		sendToSockets(globalClients, {
			session,
			type: 'snapshot',
		});
		sendGlobalPresence(globalClients);

		return {
			session,
		};
	});

	app.patch('/api/global-session', async (request) => {
		const globalSession = getCurrentGlobalSession();

		if (!globalSession) {
			throw new HttpError(404, 'No global cooking session has been started.');
		}

		const result = store.applyPatch(
			globalSession.id,
			parseSessionMutation(request.body),
		);

		sendToSession(clients, result.session.id, {
			patch: result.patch,
			session: result.session,
			type: 'patch',
		});
		sendToSockets(globalClients, {
			patch: result.patch,
			session: result.session,
			type: 'patch',
		});

		return result;
	});

	app.get('/api/sessions/:sessionId', async (request) => ({
		session: store.getSession(getSessionId(request.params)),
	}));

	app.patch('/api/sessions/:sessionId', async (request) => {
		const result = store.applyPatch(
			getSessionId(request.params),
			parseSessionMutation(request.body),
		);

		sendToSession(clients, result.session.id, {
			patch: result.patch,
			session: result.session,
			type: 'patch',
		});

		return result;
	});

	app.get(
		'/ws/sessions/:sessionId',
		{websocket: true},
		(socket: WebSocketLike, request) => {
			const sessionId = getSessionId(request.params);
			const sockets = clients.get(sessionId) ?? new Set<WebSocketLike>();
			let session: CookingSession;

			try {
				session = store.getSession(sessionId);
			} catch (error) {
				socket.send(
					serialize({
						message:
							error instanceof Error
								? error.message
								: 'Cooking session was not found.',
						type: 'error',
					}),
				);
				return;
			}

			clients.set(sessionId, sockets);
			sockets.add(socket);
			socket.send(
				serialize({
					session,
					type: 'snapshot',
				}),
			);
			sendPresence(clients, sessionId);

			socket.on('message', (data) => {
				try {
					const text =
						typeof data === 'string'
							? data
							: data
								? Buffer.from(data).toString('utf8')
								: '';
					const message = JSON.parse(text) as ClientSessionMessage;

					if (message.type !== 'patch') {
						throw new HttpError(400, 'Unsupported WebSocket message.');
					}

					const result = store.applyPatch(
						sessionId,
						parseSessionMutation(message.patch),
					);
					sendToSession(clients, sessionId, {
						patch: result.patch,
						session: result.session,
						type: 'patch',
					});
				} catch (error) {
					socket.send(
						serialize({
							message:
								error instanceof Error
									? error.message
									: 'Could not process WebSocket message.',
							type: 'error',
						}),
					);
				}
			});

			socket.on('close', () => {
				sockets.delete(socket);

				if (sockets.size === 0) {
					clients.delete(sessionId);
				} else {
					sendPresence(clients, sessionId);
				}
			});
		},
	);

	const handleGlobalWebsocket = (socket: WebSocketLike): void => {
		globalClients.add(socket);

		const session = getCurrentGlobalSession();

		if (session) {
			socket.send(
				serialize({
					session,
					type: 'snapshot',
				}),
			);
		} else {
			socket.send(
				serialize({
					message: 'No global cooking session has been started.',
					type: 'error',
				}),
			);
		}

		sendGlobalPresence(globalClients);

		socket.on('message', (data) => {
			try {
				const session = getCurrentGlobalSession();

				if (!session) {
					throw new HttpError(
						404,
						'No global cooking session has been started.',
					);
				}

				const text =
					typeof data === 'string'
						? data
						: data
							? Buffer.from(data).toString('utf8')
							: '';
				const message = JSON.parse(text) as ClientSessionMessage;

				if (message.type !== 'patch') {
					throw new HttpError(400, 'Unsupported WebSocket message.');
				}

				const result = store.applyPatch(
					session.id,
					parseSessionMutation(message.patch),
				);
				sendToSession(clients, result.session.id, {
					patch: result.patch,
					session: result.session,
					type: 'patch',
				});
				sendToSockets(globalClients, {
					patch: result.patch,
					session: result.session,
					type: 'patch',
				});
			} catch (error) {
				socket.send(
					serialize({
						message:
							error instanceof Error
								? error.message
								: 'Could not process WebSocket message.',
						type: 'error',
					}),
				);
			}
		});

		socket.on('close', () => {
			globalClients.delete(socket);
			sendGlobalPresence(globalClients);
		});
	};

	app.get('/ws', {websocket: true}, handleGlobalWebsocket);
	app.get('/ws/global-session', {websocket: true}, handleGlobalWebsocket);

	if (fs.existsSync(config.staticRoot)) {
		await app.register(fastifyStatic, {
			root: config.staticRoot,
			wildcard: false,
		});

		app.setNotFoundHandler((request, reply) => {
			if (isApiOrRealtimePath(request.url)) {
				void reply.status(404).send({message: 'Not found.'});
				return;
			}

			void reply.sendFile('index.html');
		});
	} else {
		app.setNotFoundHandler((request, reply) => {
			if (isApiOrRealtimePath(request.url)) {
				void reply.status(404).send({message: 'Not found.'});
				return;
			}

			void reply
				.type('text/html')
				.send(
					`<p>Build the frontend first with <code>pnpm run build:client</code>.</p><p>Expected ${config.staticRoot}</p>`,
				);
		});
	}

	return app;
};
