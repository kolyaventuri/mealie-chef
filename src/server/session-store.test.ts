import {describe, expect, it} from 'vitest';
import {SessionStore} from './session-store';

describe('SessionStore', () => {
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
});
