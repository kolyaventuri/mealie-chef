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
import {HttpError} from './errors';

export type CreateSessionInput = {
	recipeSlug: string;
	recipeName: string;
	ingredientKeys: string[];
};

type SessionRow = {
	active_step_index: number;
	created_at: string;
	id: string;
	ingredient_keys_json: string;
	recipe_name: string;
	recipe_slug: string;
	revision: number;
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
          revision,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, 0, ?, 0, ?, ?)
      `,
			)
			.run(
				id,
				input.recipeSlug,
				input.recipeName,
				JSON.stringify(ingredientKeys),
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

	getGlobalSession(): CookingSession | undefined {
		const row = this.database
			.prepare('SELECT value FROM app_state WHERE key = ?')
			.get(globalSessionKey) as StateRow | undefined;

		if (!row) {
			return undefined;
		}

		try {
			return this.getSession(row.value);
		} catch (error) {
			if (error instanceof HttpError && error.statusCode === 404) {
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
			updatedAt: row.updated_at,
		};
	}
}
