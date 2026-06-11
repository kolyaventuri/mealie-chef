import {mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {SessionStore} from './session-store';

const hourMs = 60 * 60 * 1000;

describe('SessionStore', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('creates sessions with reset checkoffs', () => {
		const store = new SessionStore(':memory:');
		const firstSession = store.createSession({
			ingredientKeys: ['ingredient:salt', 'ingredient:pepper'],
			recipeName: 'Soup',
			recipeSlug: 'soup',
		});

		store.applyPatch(firstSession.id, {
			checked: true,
			ingredientKey: 'ingredient:salt',
			type: 'set-ingredient-checked',
		});

		const updatedFirstSession = store.getSession(firstSession.id);
		const secondSession = store.createSession({
			ingredientKeys: ['ingredient:salt', 'ingredient:pepper'],
			recipeName: 'Soup',
			recipeSlug: 'soup',
		});

		expect(
			updatedFirstSession.ingredientStates['ingredient:salt']?.checked,
		).toBe(true);
		expect(secondSession.ingredientStates['ingredient:salt']?.checked).toBe(
			false,
		);
		store.close();
	});

	it('increments revisions as patches are applied', () => {
		const store = new SessionStore(':memory:');
		const session = store.createSession({
			ingredientKeys: ['ingredient:flour'],
			recipeName: 'Bread',
			recipeSlug: 'bread',
		});

		const result = store.applyPatch(session.id, {
			activeStepIndex: 2,
			type: 'set-active-step',
		});

		expect(result.patch).toEqual(
			expect.objectContaining({
				activeStepIndex: 2,
				revision: 1,
				type: 'set-active-step',
			}),
		);
		expect(result.session.activeStepIndex).toBe(2);
		store.close();
	});

	it('tracks the current global session separately from historical sessions', () => {
		const store = new SessionStore(':memory:');
		const firstSession = store.createGlobalSession({
			ingredientKeys: ['ingredient:rice'],
			recipeName: 'Rice',
			recipeSlug: 'rice',
		});
		const secondSession = store.createGlobalSession({
			ingredientKeys: ['ingredient:noodle'],
			recipeName: 'Noodles',
			recipeSlug: 'noodles',
		});

		expect(store.getGlobalSession()).toMatchObject({
			id: secondSession.id,
			recipeSlug: 'noodles',
		});
		expect(store.getSession(firstSession.id)).toMatchObject({
			id: firstSession.id,
			recipeSlug: 'rice',
		});
		store.close();
	});

	it('persists the current global session and progress across restarts', () => {
		const directory = mkdtempSync(path.join(tmpdir(), 'mealie-session-store-'));
		const databasePath = path.join(directory, 'sessions.sqlite');

		try {
			const store = new SessionStore(databasePath);
			const session = store.createGlobalSession({
				ingredientKeys: ['ingredient:rice', 'ingredient:salt'],
				recipeName: 'Rice',
				recipeSlug: 'rice',
			});

			store.applyPatch(session.id, {
				activeStepIndex: 2,
				type: 'set-active-step',
			});
			store.applyPatch(session.id, {
				checked: true,
				ingredientKey: 'ingredient:salt',
				type: 'set-ingredient-checked',
			});
			store.close();

			const restartedStore = new SessionStore(databasePath);
			const restartedSession = restartedStore.getGlobalSession();

			expect(restartedSession).toMatchObject({
				activeStepIndex: 2,
				id: session.id,
				recipeSlug: 'rice',
				revision: 2,
			});
			expect(
				restartedSession?.ingredientStates['ingredient:salt']?.checked,
			).toBe(true);
			restartedStore.close();
		} finally {
			rmSync(directory, {force: true, recursive: true});
		}
	});

	it('expires stale global sessions without deleting historical sessions', () => {
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(new Date('2026-06-09T00:00:00.000Z'));

		const store = new SessionStore(':memory:');
		const session = store.createGlobalSession({
			ingredientKeys: ['ingredient:rice'],
			recipeName: 'Rice',
			recipeSlug: 'rice',
		});

		vi.setSystemTime(new Date('2026-06-09T06:00:00.000Z'));
		expect(store.getGlobalSession({maxAgeMs: 6 * hourMs})).toMatchObject({
			id: session.id,
		});

		vi.setSystemTime(new Date('2026-06-09T06:00:00.001Z'));
		expect(store.getGlobalSession({maxAgeMs: 6 * hourMs})).toBeUndefined();
		expect(store.getGlobalSession()).toBeUndefined();
		expect(store.getSession(session.id)).toMatchObject({
			id: session.id,
			recipeSlug: 'rice',
		});
		store.close();
	});
});
