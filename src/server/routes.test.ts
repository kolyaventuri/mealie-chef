import type {AddressInfo} from 'node:net';
import {Buffer} from 'node:buffer';
import {afterEach, describe, expect, it, vi} from 'vitest';
import WebSocket from 'ws';
import type {ServerSessionMessage} from '../shared/types';
import type {AppConfig} from './config';
import {type MealieClient} from './mealie-client';
import {createApp} from './routes';
import {SessionStore} from './session-store';

const config: AppConfig = {
	databasePath: ':memory:',
	port: 0,
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
});
