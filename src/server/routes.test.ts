import type {AddressInfo} from 'node:net';
import {Buffer} from 'node:buffer';
import {afterEach, describe, expect, it, vi} from 'vitest';
import WebSocket from 'ws';
import type {ServerSessionMessage} from '../shared/types';
import type {AppConfig} from './config';
import {type MealieClient} from './mealie-client';
import {createApp} from './routes';
import {SessionStore} from './session-store';

const hourMs = 60 * 60 * 1000;

const config: AppConfig = {
	databasePath: ':memory:',
	openAiRecipeModel: 'gpt-5.6-luna',
	openAiRecipeReasoningEffort: 'medium',
	port: 0,
	sessionMaxAgeMs: 6 * hourMs,
	staticRoot: '/path/that/does/not/exist',
};

const recipe = {
	description: 'Dinner',
	ingredients: [
		{
			display: '1 cup rice',
			key: 'ingredient:rice',
			linkedStepIndexes: [0],
		},
	],
	name: 'Rice Bowl',
	recipeServings: 4,
	slug: 'rice-bowl',
	steps: [
		{
			index: 0,
			linkedIngredientKeys: ['ingredient:rice'],
			text: 'Cook rice.',
		},
		{
			index: 1,
			linkedIngredientKeys: [],
			text: 'Serve.',
		},
	],
	tools: [],
};

const createMockMealie = () =>
	({
		getRecipe: vi.fn(async () => recipe),
		getTodayMealPlans: vi.fn(async () => []),
		getWeekMealPlans: vi.fn(async () => [
			{
				date: '2026-06-02',
				id: 'plan-1',
				mealType: 'Dinner',
				recipe: {
					name: recipe.name,
					slug: recipe.slug,
				},
			},
		]),
		proxy: vi.fn(),
		searchRecipes: vi.fn(async () => [
			{
				name: recipe.name,
				slug: recipe.slug,
			},
		]),
	}) as unknown as MealieClient;

const waitForMessage = async (
	socket: WebSocket,
	predicate: (message: ServerSessionMessage) => boolean,
): Promise<ServerSessionMessage> =>
	new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error('Timed out waiting for websocket message.'));
		}, 2000);

		socket.on('message', (data) => {
			const text =
				typeof data === 'string'
					? data
					: Array.isArray(data)
						? Buffer.concat(data).toString('utf8')
						: data instanceof ArrayBuffer
							? Buffer.from(data).toString('utf8')
							: Buffer.from(data).toString('utf8');
			const message = JSON.parse(text) as ServerSessionMessage;

			if (predicate(message)) {
				clearTimeout(timeout);
				resolve(message);
			}
		});
	});

describe('routes', () => {
	const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];
	const sockets: WebSocket[] = [];

	afterEach(async () => {
		vi.useRealTimers();

		for (const socket of sockets.splice(0)) {
			socket.close();
		}

		await Promise.all(apps.splice(0).map(async (app) => app.close()));
	});

	it('serves week planner, recipe search, recipe details, and global session lifecycle', async () => {
		const app = await createApp({
			config,
			mealieClient: createMockMealie(),
			sessionStore: new SessionStore(':memory:'),
		});
		apps.push(app);

		const plannerResponse = await app.inject(
			'/api/planner/week?start=2026-06-01&end=2026-06-07',
		);
		expect(plannerResponse.statusCode).toBe(200);
		expect(plannerResponse.json()).toMatchObject({
			days: expect.arrayContaining([
				expect.objectContaining({
					date: '2026-06-02',
					entries: [expect.objectContaining({mealType: 'Dinner'})],
				}),
			]),
		});

		const searchResponse = await app.inject('/api/recipes?query=rice');
		expect(searchResponse.json()).toEqual({
			recipes: [
				{
					name: recipe.name,
					slug: recipe.slug,
				},
			],
		});

		const sessionResponse = await app.inject({
			body: {
				recipeSlug: recipe.slug,
			},
			method: 'POST',
			url: '/api/global-session',
		});
		expect(sessionResponse.statusCode).toBe(200);
		expect(sessionResponse.json().session.servings).toBe(4);
		const sessionId = sessionResponse.json().session.id as string;

		const globalSessionResponse = await app.inject('/api/global-session');
		expect(globalSessionResponse.json()).toMatchObject({
			session: {
				id: sessionId,
				recipeSlug: recipe.slug,
			},
		});

		const patchResponse = await app.inject({
			body: {
				activeStepIndex: 1,
				type: 'set-active-step',
			},
			method: 'PATCH',
			url: '/api/global-session',
		});
		expect(patchResponse.json().session).toMatchObject({
			activeStepIndex: 1,
			revision: 1,
		});
	});

	it('marks today using the configured app timezone', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(new Date('2026-06-04T02:00:00.000Z'));

		const app = await createApp({
			config: {
				...config,
				appTimeZone: 'Etc/GMT+7',
			},
			mealieClient: createMockMealie(),
			sessionStore: new SessionStore(':memory:'),
		});
		apps.push(app);

		const response = await app.inject('/api/planner/week');
		const body: {
			days: Array<{date: string; isToday: boolean}>;
			end: string;
			start: string;
			today: string;
		} = response.json();

		expect(body).toMatchObject({
			end: '2026-06-06',
			start: '2026-05-31',
			today: '2026-06-03',
		});
		expect(body.days.find((day) => day.date === '2026-06-03')).toMatchObject({
			isToday: true,
		});
		expect(body.days.find((day) => day.date === '2026-06-04')).toMatchObject({
			isToday: false,
		});
	});

	it('syncs servings across clients, HTTP fallback, and reconnects without writing to Mealie', async () => {
		const mealie = createMockMealie();
		const original = structuredClone(recipe);
		const app = await createApp({
			config,
			mealieClient: mealie,
			sessionStore: new SessionStore(':memory:'),
		});
		apps.push(app);
		await app.listen({host: '127.0.0.1', port: 0});
		const created = await app.inject({
			method: 'POST',
			url: '/api/global-session',
			body: {recipeSlug: recipe.slug},
		});
		const sessionId = created.json().session.id as string;
		const address = app.server.address() as AddressInfo;
		const url = `ws://127.0.0.1:${address.port}/ws`;
		const first = new WebSocket(url);
		const second = new WebSocket(url);
		sockets.push(first, second);
		await Promise.all([
			waitForMessage(first, (m) => m.type === 'snapshot'),
			waitForMessage(second, (m) => m.type === 'snapshot'),
		]);
		const firstUpdate = waitForMessage(
			first,
			(m) => m.type === 'patch' && m.session.servings === 6,
		);
		const secondUpdate = waitForMessage(
			second,
			(m) => m.type === 'patch' && m.session.servings === 6,
		);
		const adjustment = JSON.stringify({
			type: 'patch',
			patch: {type: 'adjust-servings', change: 1, defaultServings: 4},
		});
		first.send(adjustment);
		second.send(adjustment);
		for (const result of await Promise.all([firstUpdate, secondUpdate])) {
			expect(result).toMatchObject({session: {servings: 6, revision: 2}});
		}

		const reconnected = new WebSocket(url);
		sockets.push(reconnected);
		expect(
			await waitForMessage(reconnected, (m) => m.type === 'snapshot'),
		).toMatchObject({session: {servings: 6}});
		const httpUpdate = waitForMessage(
			second,
			(m) => m.type === 'patch' && m.session.servings === 5,
		);
		const changed = await app.inject({
			method: 'PATCH',
			url: '/api/global-session',
			body: {type: 'adjust-servings', change: -1, defaultServings: 4},
		});
		expect(changed.json().session.servings).toBe(5);
		await httpUpdate;
		const resetUpdate = waitForMessage(
			second,
			(m) => m.type === 'patch' && m.session.servings === null,
		);
		await app.inject({
			method: 'PATCH',
			url: '/api/global-session',
			body: {type: 'set-servings', servings: null},
		});
		await resetUpdate;
		const saved = await app.inject(`/api/sessions/${sessionId}`);
		expect(saved.json().session.servings).toBeNull();
		expect(mealie.getRecipe).toHaveBeenCalledTimes(1);
		expect(recipe).toEqual(original);
	});

	it.each([
		{type: 'set-servings', servings: 0},
		{type: 'set-servings', servings: -2},
		{type: 'set-servings', servings: '6'},
		{type: 'set-servings'},
		{type: 'adjust-servings', change: 2, defaultServings: 4},
		{type: 'adjust-servings', change: 1, defaultServings: 0},
	])('rejects malformed serving mutations %s', async (body) => {
		const app = await createApp({
			config,
			mealieClient: createMockMealie(),
			sessionStore: new SessionStore(':memory:'),
		});
		apps.push(app);
		await app.inject({
			method: 'POST',
			url: '/api/global-session',
			body: {recipeSlug: recipe.slug},
		});
		const response = await app.inject({
			method: 'PATCH',
			url: '/api/global-session',
			body,
		});
		expect(response.statusCode).toBe(400);
		const saved = await app.inject('/api/global-session');
		expect(saved.json().session).toMatchObject({servings: 4, revision: 0});
	});

	it('expires global sessions using the configured max age', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(new Date('2026-06-09T00:00:00.000Z'));

		const sessionStore = new SessionStore(':memory:');
		const app = await createApp({
			config: {
				...config,
				sessionMaxAgeMs: hourMs,
			},
			mealieClient: createMockMealie(),
			sessionStore,
		});
		apps.push(app);

		const sessionResponse = await app.inject({
			body: {
				recipeSlug: recipe.slug,
			},
			method: 'POST',
			url: '/api/global-session',
		});
		expect(sessionResponse.statusCode).toBe(200);
		const sessionId = sessionResponse.json().session.id as string;

		vi.setSystemTime(new Date('2026-06-09T01:00:00.001Z'));

		const globalSessionResponse = await app.inject('/api/global-session');
		expect(globalSessionResponse.json()).toEqual({
			session: null,
		});

		const patchResponse = await app.inject({
			body: {
				activeStepIndex: 1,
				type: 'set-active-step',
			},
			method: 'PATCH',
			url: '/api/global-session',
		});
		expect(patchResponse.statusCode).toBe(404);
		expect(sessionStore.getSession(sessionId)).toMatchObject({
			id: sessionId,
			recipeSlug: recipe.slug,
		});
	});

	it('syncs patches between global websocket clients', async () => {
		const app = await createApp({
			config,
			mealieClient: createMockMealie(),
			sessionStore: new SessionStore(':memory:'),
		});
		apps.push(app);
		await app.listen({host: '127.0.0.1', port: 0});

		const sessionResponse = await app.inject({
			body: {
				recipeSlug: recipe.slug,
			},
			method: 'POST',
			url: '/api/global-session',
		});
		expect(sessionResponse.statusCode).toBe(200);
		const address = app.server.address() as AddressInfo;
		const url = `ws://127.0.0.1:${address.port}/ws/global-session`;
		const firstSocket = new WebSocket(url);
		const secondSocket = new WebSocket(url);
		sockets.push(firstSocket, secondSocket);

		await Promise.all([
			waitForMessage(firstSocket, (message) => message.type === 'snapshot'),
			waitForMessage(secondSocket, (message) => message.type === 'snapshot'),
		]);

		firstSocket.send(
			JSON.stringify({
				patch: {
					activeStepIndex: 1,
					type: 'set-active-step',
				},
				type: 'patch',
			}),
		);

		const patchMessage = await waitForMessage(
			secondSocket,
			(message) =>
				message.type === 'patch' && message.patch.type === 'set-active-step',
		);

		expect(patchMessage).toMatchObject({
			patch: {
				activeStepIndex: 1,
				revision: 1,
			},
			session: {
				activeStepIndex: 1,
			},
			type: 'patch',
		});
	});

	it('supports bare /ws as the global websocket route', async () => {
		const app = await createApp({
			config,
			mealieClient: createMockMealie(),
			sessionStore: new SessionStore(':memory:'),
		});
		apps.push(app);
		await app.listen({host: '127.0.0.1', port: 0});

		const sessionResponse = await app.inject({
			body: {
				recipeSlug: recipe.slug,
			},
			method: 'POST',
			url: '/api/global-session',
		});
		expect(sessionResponse.statusCode).toBe(200);
		const address = app.server.address() as AddressInfo;
		const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
		sockets.push(socket);

		const snapshot = await waitForMessage(
			socket,
			(message) => message.type === 'snapshot',
		);

		expect(snapshot).toMatchObject({
			session: {
				recipeSlug: recipe.slug,
			},
			type: 'snapshot',
		});
	});

	it('sends websocket heartbeats while clients are connected', async () => {
		const app = await createApp({
			config,
			mealieClient: createMockMealie(),
			sessionStore: new SessionStore(':memory:'),
			websocketHeartbeatIntervalMs: 10,
		});
		apps.push(app);
		await app.listen({host: '127.0.0.1', port: 0});

		const sessionResponse = await app.inject({
			body: {
				recipeSlug: recipe.slug,
			},
			method: 'POST',
			url: '/api/global-session',
		});
		expect(sessionResponse.statusCode).toBe(200);
		const address = app.server.address() as AddressInfo;
		const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
		sockets.push(socket);

		await waitForMessage(socket, (message) => message.type === 'snapshot');
		await expect(
			waitForMessage(socket, (message) => message.type === 'heartbeat'),
		).resolves.toEqual({
			type: 'heartbeat',
		});
	});

	it('does not serve the SPA fallback for a non-upgraded /ws request', async () => {
		const app = await createApp({
			config,
			mealieClient: createMockMealie(),
			sessionStore: new SessionStore(':memory:'),
		});
		apps.push(app);

		const response = await app.inject('/ws');

		expect(response.statusCode).toBe(404);
		expect(response.body).not.toContain('<div id="root">');
	});
});
