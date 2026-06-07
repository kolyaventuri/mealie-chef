import {Buffer} from 'node:buffer';
import fs from 'node:fs';
import process from 'node:process';
import {clearInterval, setInterval} from 'node:timers';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import cors from '@fastify/cors';
import fastify, {type FastifyInstance} from 'fastify';
import {getDateRange, getWeekRange} from '../shared/date';
import type {
	ClientSessionMessage,
	CookingSession,
	ISODate,
	MealPlanEntry,
	ServerSessionMessage,
	SessionMutation,
} from '../shared/types';
import type {AppConfig} from './config';
import {HttpError, isRecord} from './errors';
import {MealieClient} from './mealie-client';
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
	mealieClient?: MealieClient;
	sessionStore?: SessionStore;
	websocketHeartbeatIntervalMs?: number;
};

const openState = 1;
const defaultWebsocketHeartbeatIntervalMs = 25_000;

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
	url === '/ws' || url.startsWith('/api/') || url.startsWith('/ws/');

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

export const createApp = async ({
	config,
	mealieClient,
	sessionStore,
	websocketHeartbeatIntervalMs = defaultWebsocketHeartbeatIntervalMs,
}: AppDependencies): Promise<FastifyInstance> => {
	const app = fastify({
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
	const store = sessionStore ?? new SessionStore(config.databasePath);
	const clients = new Map<string, Set<WebSocketLike>>();
	const globalClients = new Set<WebSocketLike>();
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

	app.setErrorHandler((error, _request, reply) => {
		const statusCode = error instanceof HttpError ? error.statusCode : 500;
		const message =
			statusCode === 500
				? 'Unexpected server error.'
				: error instanceof Error
					? error.message
					: 'Request failed.';

		if (statusCode === 500) {
			app.log.error(error);
		}

		void reply.status(statusCode).send({message});
	});

	await app.register(fastifyWebsocket);

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

	app.post('/api/sessions', async (request) => {
		const recipeSlug = getRecipeSlug(request.body);
		const recipe = await mealie.getRecipe(recipeSlug);
		const session = store.createSession({
			ingredientKeys: recipe.ingredients.map((ingredient) => ingredient.key),
			recipeName: recipe.name,
			recipeSlug: recipe.slug,
		});

		return {
			session,
		};
	});

	app.get('/api/global-session', async () => ({
		session: store.getGlobalSession() ?? null,
	}));

	app.post('/api/global-session', async (request) => {
		const recipeSlug = getRecipeSlug(request.body);
		const recipe = await mealie.getRecipe(recipeSlug);
		const session = store.createGlobalSession({
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
		const globalSession = store.getGlobalSession();

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

		const session = store.getGlobalSession();

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
				const session = store.getGlobalSession();

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
