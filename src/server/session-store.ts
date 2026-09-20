import {mkdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {DatabaseSync, type StatementSync} from 'node:sqlite';
import type {
	CookingSession,
	IngredientState,
	SessionMutation,
	SessionPatch,
} from '../shared/types';
import {isValidServings} from '../shared/recipe-scaling';
import {HttpError} from './errors';

export type CreateSessionInput = {
	recipeSlug: string;
	recipeName: string;
	ingredientKeys: string[];
	servings?: number;
};

export type GetGlobalSessionOptions = {
	maxAgeMs?: number;
	now?: Date;
};

type SessionRow = {
	active_step_index: number;
	created_at: string;
	id: string;
	ingredient_keys_json: string;
	recipe_name: string;
	recipe_slug: string;
	revision: number;
	servings: CookingSession['servings'];
	updated_at: string;
};

type CheckRow = {
	checked: number;
	ingredient_key: string;
	updated_at: string;
};

type StateRow = {
	value: string;
};

const globalSessionKey = 'global_session_id';

const nowISOString = (): string => new Date().toISOString();

const normalizeIngredientKeys = (ingredientKeys: string[]): string[] =>
	[...new Set(ingredientKeys)].toSorted();

export class SessionStore {
	private readonly database: DatabaseSync;
	private readonly getSessionStatement: StatementSync;
	private readonly getChecksStatement: StatementSync;

	constructor(databasePath: string) {
		if (databasePath !== ':memory:') {
			mkdirSync(path.dirname(databasePath), {recursive: true});
		}

		this.database = new DatabaseSync(databasePath);
		this.database.exec('PRAGMA foreign_keys = ON;');
		this.database.exec('PRAGMA journal_mode = WAL;');
		this.database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        recipe_slug TEXT NOT NULL,
        recipe_name TEXT NOT NULL,
        active_step_index INTEGER NOT NULL DEFAULT 0,
        ingredient_keys_json TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ingredient_checks (
        session_id TEXT NOT NULL,
        ingredient_key TEXT NOT NULL,
        checked INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, ingredient_key),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

		const columns = this.database.prepare('PRAGMA table_info(sessions)').all();
		if (!columns.some((column) => column.name === 'servings')) {
			this.database.exec('ALTER TABLE sessions ADD COLUMN servings REAL;');
		}

		this.getSessionStatement = this.database.prepare(
			'SELECT * FROM sessions WHERE id = ?',
		);
		this.getChecksStatement = this.database.prepare(
			'SELECT ingredient_key, checked, updated_at FROM ingredient_checks WHERE session_id = ?',
		);
	}

	close(): void {
		this.database.close();
	}

	createSession(input: CreateSessionInput): CookingSession {
		const id = randomUUID().slice(0, 8);
		const timestamp = nowISOString();
		const ingredientKeys = normalizeIngredientKeys(input.ingredientKeys);

		this.database
			.prepare(
				`
        INSERT INTO sessions (
          id,
          recipe_slug,
          recipe_name,
          active_step_index,
          ingredient_keys_json,
          servings,
          revision,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, 0, ?, ?, 0, ?, ?)
      `,
			)
			.run(
				id,
				input.recipeSlug,
				input.recipeName,
				JSON.stringify(ingredientKeys),
				isValidServings(input.servings) ? input.servings : null,
				timestamp,
				timestamp,
			);

		const insertCheck = this.database.prepare(
			`
        INSERT INTO ingredient_checks (session_id, ingredient_key, checked, updated_at)
        VALUES (?, ?, 0, ?)
      `,
		);

		for (const ingredientKey of ingredientKeys) {
			insertCheck.run(id, ingredientKey, timestamp);
		}

		return this.getSession(id);
	}

	createGlobalSession(input: CreateSessionInput): CookingSession {
		const session = this.createSession(input);
		this.setGlobalSessionId(session.id);

		return session;
	}

	getGlobalSession(
		options: GetGlobalSessionOptions = {},
	): CookingSession | undefined {
		const row = this.database
			.prepare('SELECT value FROM app_state WHERE key = ?')
			.get(globalSessionKey) as StateRow | undefined;

		if (!row) {
			return undefined;
		}

		try {
			const session = this.getSession(row.value);

			if (this.isStaleGlobalSession(session, options)) {
				this.clearGlobalSessionId();
				return undefined;
			}

			return session;
		} catch (error) {
			if (error instanceof HttpError && error.statusCode === 404) {
				this.clearGlobalSessionId();
				return undefined;
			}

			throw error;
		}
	}

	setGlobalSessionId(sessionId: string): void {
		this.getSession(sessionId);
		this.database
			.prepare(
				`
          INSERT INTO app_state (key, value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key)
          DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `,
			)
			.run(globalSessionKey, sessionId, nowISOString());
	}

	getSession(id: string): CookingSession {
		const row = this.getSessionStatement.get(id) as SessionRow | undefined;

		if (!row) {
			throw new HttpError(404, 'Cooking session was not found.');
		}

		return this.rowToSession(row);
	}

	applyPatch(
		id: string,
		mutation: SessionMutation,
	): {patch: SessionPatch; session: CookingSession} {
		const session = this.getSession(id);
		const timestamp = nowISOString();

		switch (mutation.type) {
			case 'set-servings':
			case 'adjust-servings': {
				if (
					mutation.type === 'adjust-servings' &&
					(!isValidServings(mutation.defaultServings) ||
						(mutation.change !== -1 && mutation.change !== 1))
				) {
					throw new HttpError(400, 'Serving adjustment is invalid.');
				}

				const servings =
					mutation.type === 'set-servings'
						? mutation.servings
						: Math.max(
								Math.min(1, mutation.defaultServings),
								(session.servings ?? mutation.defaultServings) +
									mutation.change,
							);

				if (servings !== null && !isValidServings(servings)) {
					throw new HttpError(
						400,
						'Servings must be a positive finite number.',
					);
				}

				this.database
					.prepare(
						`
					UPDATE sessions
					SET servings = ?, revision = revision + 1, updated_at = ?
					WHERE id = ?
				`,
					)
					.run(servings, timestamp, id);
				break;
			}

			case 'set-active-step': {
				const activeStepIndex = Math.max(
					0,
					Math.floor(mutation.activeStepIndex),
				);
				this.database
					.prepare(
						`
              UPDATE sessions
              SET active_step_index = ?, revision = revision + 1, updated_at = ?
              WHERE id = ?
            `,
					)
					.run(activeStepIndex, timestamp, id);
				break;
			}

			case 'set-ingredient-checked': {
				this.assertKnownIngredient(session, mutation.ingredientKey);
				this.database
					.prepare(
						`
              INSERT INTO ingredient_checks (session_id, ingredient_key, checked, updated_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(session_id, ingredient_key)
              DO UPDATE SET checked = excluded.checked, updated_at = excluded.updated_at
            `,
					)
					.run(id, mutation.ingredientKey, mutation.checked ? 1 : 0, timestamp);
				this.bumpSession(id, timestamp);
				break;
			}
		}

		const nextSession = this.getSession(id);

		return {
			patch: {
				...mutation,
				revision: nextSession.revision,
				updatedAt: nextSession.updatedAt,
			},
			session: nextSession,
		};
	}

	private bumpSession(id: string, timestamp: string): void {
		this.database
			.prepare(
				'UPDATE sessions SET revision = revision + 1, updated_at = ? WHERE id = ?',
			)
			.run(timestamp, id);
	}

	private clearGlobalSessionId(): void {
		this.database
			.prepare('DELETE FROM app_state WHERE key = ?')
			.run(globalSessionKey);
	}

	private isStaleGlobalSession(
		session: CookingSession,
		options: GetGlobalSessionOptions,
	): boolean {
		if (options.maxAgeMs === undefined) {
			return false;
		}

		const updatedAt = Date.parse(session.updatedAt);

		if (Number.isNaN(updatedAt)) {
			return false;
		}

		return (options.now ?? new Date()).getTime() - updatedAt > options.maxAgeMs;
	}

	private assertKnownIngredient(
		session: CookingSession,
		ingredientKey: string,
	): void {
		if (!session.ingredientKeys.includes(ingredientKey)) {
			throw new HttpError(
				400,
				'Ingredient does not belong to this cooking session.',
			);
		}
	}

	private rowToSession(row: SessionRow): CookingSession {
		const ingredientKeys = JSON.parse(row.ingredient_keys_json) as string[];
		const checkRows = this.getChecksStatement.all(row.id) as CheckRow[];
		const ingredientStates: Record<string, IngredientState> = {};

		for (const ingredientKey of ingredientKeys) {
			ingredientStates[ingredientKey] = {
				checked: false,
				ingredientKey,
				updatedAt: row.created_at,
			};
		}

		for (const check of checkRows) {
			ingredientStates[check.ingredient_key] = {
				checked: Boolean(check.checked),
				ingredientKey: check.ingredient_key,
				updatedAt: check.updated_at,
			};
		}

		return {
			activeStepIndex: row.active_step_index,
			createdAt: row.created_at,
			id: row.id,
			ingredientKeys,
			ingredientStates,
			recipeName: row.recipe_name,
			recipeSlug: row.recipe_slug,
			revision: row.revision,
			servings: row.servings,
			updatedAt: row.updated_at,
		};
	}
}
