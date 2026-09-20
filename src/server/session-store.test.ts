import {mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
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
			store.applyPatch(session.id, {type: 'set-servings', servings: 6});
			store.close();

			const restartedStore = new SessionStore(databasePath);
			const restartedSession = restartedStore.getGlobalSession();

			expect(restartedSession).toMatchObject({
				activeStepIndex: 2,
				id: session.id,
				recipeSlug: 'rice',
				revision: 3,
				servings: 6,
			});
			expect(
				restartedSession?.ingredientStates['ingredient:salt']?.checked,
			).toBe(true);
			restartedStore.close();
		} finally {
			rmSync(directory, {force: true, recursive: true});
		}
	});

	it('applies rapid adjustments, clamps the minimum, and resets only servings', () => {
		const store = new SessionStore(':memory:');
		const input = {
			recipeSlug: 'rice',
			recipeName: 'Rice',
			ingredientKeys: ['rice'],
			servings: 4,
		};
		const session = store.createGlobalSession(input);
		expect(session.servings).toBe(4);
		store.applyPatch(session.id, {
			type: 'set-ingredient-checked',
			ingredientKey: 'rice',
			checked: true,
		});
		store.applyPatch(session.id, {
			type: 'adjust-servings',
			change: 1,
			defaultServings: 4,
		});
		store.applyPatch(session.id, {
			type: 'adjust-servings',
			change: 1,
			defaultServings: 4,
		});
		expect(store.getSession(session.id).servings).toBe(6);
		store.applyPatch(session.id, {type: 'set-servings', servings: 1});
		store.applyPatch(session.id, {
			type: 'adjust-servings',
			change: -1,
			defaultServings: 4,
		});
		expect(store.getSession(session.id).servings).toBe(1);
		const reset = store.applyPatch(session.id, {
			type: 'set-servings',
			servings: null,
		});
		expect(reset.session.servings).toBeNull();
		expect(reset.session.ingredientStates.rice.checked).toBe(true);
		store.applyPatch(session.id, {
			type: 'adjust-servings',
			change: -1,
			defaultServings: 4,
		});
		expect(store.getSession(session.id).servings).toBe(3);
		expect(store.createGlobalSession(input).servings).toBe(4);
		store.close();
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE])(
		'rejects invalid servings %s without changing the session',
		(servings) => {
			const store = new SessionStore(':memory:');
			const session = store.createSession({
				recipeSlug: 'rice',
				recipeName: 'Rice',
				ingredientKeys: [],
				servings: 4,
			});
			expect(() =>
				store.applyPatch(session.id, {type: 'set-servings', servings}),
			).toThrow('Servings must be');
			expect(store.getSession(session.id)).toEqual(session);
			store.close();
		},
	);

	it('migrates an existing database without losing its current session or checks', () => {
		const directory = mkdtempSync(
			path.join(tmpdir(), 'mealie-serving-migration-'),
		);
		const databasePath = path.join(directory, 'sessions.sqlite');
		try {
			const database = new DatabaseSync(databasePath);
			database.exec(`
				CREATE TABLE sessions (
					id TEXT PRIMARY KEY, recipe_slug TEXT NOT NULL, recipe_name TEXT NOT NULL,
					active_step_index INTEGER NOT NULL DEFAULT 0, ingredient_keys_json TEXT NOT NULL,
					revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
				);
				INSERT INTO sessions VALUES ('old', 'rice', 'Rice', 2, '["rice"]', 5, '2026-09-19', '2026-09-19');
				CREATE TABLE ingredient_checks (session_id TEXT, ingredient_key TEXT, checked INTEGER, updated_at TEXT, PRIMARY KEY (session_id, ingredient_key));
				INSERT INTO ingredient_checks VALUES ('old', 'rice', 1, '2026-09-19');
				CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
				INSERT INTO app_state VALUES ('global_session_id', 'old', '2026-09-19');
			`);
			database.close();
			const store = new SessionStore(databasePath);
			expect(store.getGlobalSession()).toMatchObject({
				id: 'old',
				activeStepIndex: 2,
				revision: 5,
				servings: null,
				ingredientStates: {rice: {checked: true}},
			});
			expect(
				store.applyPatch('old', {
					type: 'adjust-servings',
					change: 1,
					defaultServings: 4,
				}).session.servings,
			).toBe(5);
			store.close();
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
