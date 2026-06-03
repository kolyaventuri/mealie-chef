import type {
	CookingSession,
	RecipeDetail,
	RecipeSummary,
	SessionMutation,
	WeekPlannerResponse,
} from '../shared/types';

type RecipeListResponse = {
	recipes: RecipeSummary[];
};

type RecipeResponse = {
	recipe: RecipeDetail;
};

type SessionResponse = {
	session: CookingSession;
};

type GlobalSessionResponse = {
	session?: CookingSession;
};

type PatchResponse = {
	session: CookingSession;
};

const jsonRequest = async <T>(
	inPath: string,
	options: RequestInit = {},
): Promise<T> => {
	const path =
		import.meta.env.VITE_NODE_ENV === 'local'
			? `http://localhost:3100${inPath}`
			: inPath;
	const response = await fetch(path, {
		...options,
		headers: {
			'Content-Type': 'application/json',
			...options.headers,
		},
	});

	if (!response.ok) {
		const payload = (await response.json().catch(() => ({}))) as {
			message?: string;
		};
		throw new Error(
			payload.message ?? `Request failed with ${response.status}`,
		);
	}

	return response.json() as Promise<T>;
};

export const api = {
	async createSession(recipeSlug: string): Promise<CookingSession> {
		const {session} = await jsonRequest<SessionResponse>(
			'/api/global-session',
			{
				body: JSON.stringify({recipeSlug}),
				method: 'POST',
			},
		);

		return session;
	},

	async getRecipe(slug: string): Promise<RecipeDetail> {
		const {recipe} = await jsonRequest<RecipeResponse>(
			`/api/recipes/${encodeURIComponent(slug)}`,
		);

		return recipe;
	},

	async getSession(sessionId: string): Promise<CookingSession> {
		const {session} = await jsonRequest<SessionResponse>(
			`/api/sessions/${encodeURIComponent(sessionId)}`,
		);

		return session;
	},

	async getGlobalSession(): Promise<CookingSession | undefined> {
		const {session} = await jsonRequest<GlobalSessionResponse>(
			'/api/global-session',
		);

		return session;
	},

	async getWeekPlanner(): Promise<WeekPlannerResponse> {
		return jsonRequest<WeekPlannerResponse>('/api/planner/week');
	},

	async patchSession(
		sessionId: string,
		patch: SessionMutation,
	): Promise<CookingSession> {
		const {session} = await jsonRequest<PatchResponse>(
			`/api/sessions/${encodeURIComponent(sessionId)}`,
			{
				body: JSON.stringify(patch),
				method: 'PATCH',
			},
		);

		return session;
	},

	async patchGlobalSession(patch: SessionMutation): Promise<CookingSession> {
		const {session} = await jsonRequest<PatchResponse>('/api/global-session', {
			body: JSON.stringify(patch),
			method: 'PATCH',
		});

		return session;
	},

	async searchRecipes(query: string): Promise<RecipeSummary[]> {
		const parameters = new URLSearchParams({query});
		const {recipes} = await jsonRequest<RecipeListResponse>(
			`/api/recipes?${parameters}`,
		);

		return recipes;
	},
};

export const websocketUrl = (sessionId: string): string => {
	const protocol = globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:';

	return `${protocol}//${globalThis.location.host}/ws/sessions/${encodeURIComponent(sessionId)}`;
};

export const globalWebsocketUrl = (): string => {
	const protocol = globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:';

	return `${protocol}//${globalThis.location.host}/ws`;
};
