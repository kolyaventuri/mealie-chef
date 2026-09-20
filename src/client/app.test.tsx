// @vitest-environment jsdom

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {CookingSession, RecipeDetail} from '../shared/types';
import {api} from './api';
import {App} from './app';

vi.mock('./api', () => ({
	api: {
		getGlobalSession: vi.fn(),
		getRecipe: vi.fn(),
		patchGlobalSession: vi.fn(),
	},
	globalWebsocketUrl: () => 'ws://localhost/ws',
}));

class MockSocket extends EventTarget {
	static OPEN = 1;
	static CLOSED = 3;
	static instances: MockSocket[] = [];
	readyState = 1;
	send = vi.fn();
	close = vi.fn();
	constructor() {
		super();
		MockSocket.instances.push(this);
	}

	receive(session: CookingSession): void {
		this.dispatchEvent(
			new MessageEvent('message', {
				data: JSON.stringify({type: 'snapshot', session}),
			}),
		);
	}
}

const session: CookingSession = {
	id: 'soup-session',
	recipeName: 'Soup',
	recipeSlug: 'soup',
	servings: 4,
	revision: 0,
	activeStepIndex: 0,
	createdAt: '2026-09-19',
	updatedAt: '2026-09-19',
	ingredientKeys: ['rice', 'salt'],
	ingredientStates: {
		rice: {ingredientKey: 'rice', checked: true, updatedAt: '2026-09-19'},
	},
};
const recipe: RecipeDetail = {
	name: 'Soup',
	slug: 'soup',
	recipeServings: 4,
	tools: [],
	ingredients: [
		{
			key: 'rice',
			quantity: '1',
			unit: 'cup',
			food: 'rice',
			display: '1 cup rice',
			note: 'rinsed',
			linkedStepIndexes: [0],
		},
		{key: 'salt', display: 'Salt to taste', linkedStepIndexes: []},
	],
	steps: [
		{
			index: 0,
			text: 'Simmer 1 cup rice for 20 minutes.',
			linkedIngredientKeys: ['rice'],
		},
	],
};

describe('cooking servings', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		MockSocket.instances = [];
		vi.stubGlobal('WebSocket', MockSocket);
		globalThis.history.replaceState({}, '', '/session');
		vi.mocked(api.getGlobalSession).mockResolvedValue(structuredClone(session));
		vi.mocked(api.getRecipe).mockResolvedValue(structuredClone(recipe));
	});
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it('uses Mealie defaults, sends relative taps, and renders synced amounts and reset', async () => {
		render(<App />);
		expect(await screen.findByLabelText('Servings')).toHaveTextContent('4');
		expect(screen.getByRole('checkbox', {name: '1 cup rice'})).toBeChecked();
		const socket = MockSocket.instances[0];
		fireEvent.click(screen.getByRole('button', {name: 'Increase servings'}));
		fireEvent.click(screen.getByRole('button', {name: 'Increase servings'}));
		expect(socket.send).toHaveBeenCalledTimes(2);
		expect(JSON.parse(socket.send.mock.calls[0][0] as string)).toEqual({
			type: 'patch',
			patch: {type: 'adjust-servings', change: 1, defaultServings: 4},
		});
		act(() => {
			socket.receive({...session, servings: 6, revision: 2});
		});
		expect(screen.getByLabelText('Servings')).toHaveTextContent('6');
		expect(screen.getByRole('checkbox', {name: '1 ½ cup rice'})).toBeChecked();
		expect(screen.getByText('rinsed')).toBeInTheDocument();
		expect(screen.getByText('Salt to taste')).toBeInTheDocument();
		expect(
			screen.getByText('As written · no scalable amount'),
		).toBeInTheDocument();
		expect(
			screen.getByText('Simmer 1 cup rice for 20 minutes.'),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', {name: 'Reset'}));
		expect(JSON.parse(socket.send.mock.lastCall?.[0] as string)).toEqual({
			type: 'patch',
			patch: {type: 'set-servings', servings: null},
		});
		act(() => {
			socket.receive({...session, servings: null, revision: 3});
		});
		expect(screen.getByLabelText('Servings')).toHaveTextContent('4');
		expect(screen.getByRole('checkbox', {name: '1 cup rice'})).toBeChecked();
		expect(screen.getByRole('button', {name: 'Reset'})).toBeDisabled();
		act(() => {
			socket.receive({...session, servings: 1, revision: 4});
		});
		expect(
			screen.getByRole('button', {name: 'Decrease servings'}),
		).toBeDisabled();
	});

	it('reports an HTTP fallback failure without showing unsaved servings', async () => {
		vi.mocked(api.patchGlobalSession).mockRejectedValue(
			new Error('Connection unavailable'),
		);
		render(<App />);
		await screen.findByLabelText('Servings');
		MockSocket.instances[0].readyState = MockSocket.CLOSED;
		fireEvent.click(screen.getByRole('button', {name: 'Decrease servings'}));
		expect(
			await screen.findByText('Connection unavailable'),
		).toBeInTheDocument();
		expect(screen.getByLabelText('Servings')).toHaveTextContent('4');
		vi.mocked(api.patchGlobalSession).mockResolvedValue({
			...session,
			servings: 3,
			revision: 1,
		});
		fireEvent.click(screen.getByRole('button', {name: 'Decrease servings'}));
		await waitFor(() => {
			expect(screen.getByLabelText('Servings')).toHaveTextContent('3');
		});
		expect(screen.getByRole('checkbox', {name: '¾ cup rice'})).toBeChecked();
	});

	it('shows original amounts without controls if servings are unknown', async () => {
		vi.mocked(api.getRecipe).mockResolvedValue({
			...recipe,
			recipeServings: undefined,
		});
		render(<App />);
		expect(
			await screen.findByText(
				'Mealie hasn’t specified a serving count. Amounts are shown as written.',
			),
		).toBeInTheDocument();
		expect(
			screen.queryByRole('button', {name: 'Increase servings'}),
		).not.toBeInTheDocument();
		expect(screen.getByRole('checkbox', {name: '1 cup rice'})).toBeChecked();
	});
});
