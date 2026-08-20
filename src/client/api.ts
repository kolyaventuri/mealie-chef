import type {
	CookingSession,
	RecipeDetail,
	RecipeSummary,
	SessionMutation,
	WeekPlannerResponse,
} from '../shared/types';
import type {
	RecipeImportConfirmResponse,
	RecipeImportParseResponse,
	RecipeImportMode,
	SchemaOrgRecipe,
} from '../shared/recipe-import';

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

type ErrorResponse = {
	message?: string;
	requestId?: string;
};

export type RecipeImportRequest = {
	files: File[];
	mode: RecipeImportMode;
	text?: string;
	url?: string;
};

const requestPath = (inPath: string): string =>
	import.meta.env.VITE_NODE_ENV === 'local'
		? `http://localhost:3100${inPath}`
		: inPath;

const jsonRequest = async <T>(
	inPath: string,
	options: RequestInit = {},
): Promise<T> => {
	const path = requestPath(inPath);
	const response = await fetch(path, {
		...options,
		headers: {
			'Content-Type': 'application/json',
			...options.headers,
		},
	});

	if (!response.ok) {
		const payload = (await response.json().catch(() => ({}))) as ErrorResponse;
		const requestId = payload.requestId
			? ` (Request ID: ${payload.requestId})`
			: '';
		throw new Error(
			`${payload.message ?? `Request failed with ${response.status}`}${requestId}`,
		);
	}

	return response.json() as Promise<T>;
};

const multipartRequest = async <T>(
	inPath: string,
	formData: FormData,
): Promise<T> => {
	const response = await fetch(requestPath(inPath), {
		body: formData,
		method: 'POST',
	});

	if (!response.ok) {
		const payload = (await response.json().catch(() => ({}))) as ErrorResponse;
		const requestId = payload.requestId
			? ` (Request ID: ${payload.requestId})`
			: '';
		throw new Error(
			`${payload.message ?? `Request failed with ${response.status}`}${requestId}`,
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

	async parseRecipeImport(
		input: RecipeImportRequest,
	): Promise<RecipeImportParseResponse> {
		const formData = new FormData();
		formData.set('mode', input.mode);

		if (input.url) {
			formData.set('url', input.url);
		}

		if (input.text) {
			formData.set('text', input.text);
		}

		if (input.mode === 'images') {
			for (const file of input.files) {
				formData.append('images', file, file.name);
			}
		}

		return multipartRequest<RecipeImportParseResponse>(
			'/import/parse',
			formData,
		);
	},

	async confirmRecipeImport(
		recipe: SchemaOrgRecipe,
	): Promise<RecipeImportConfirmResponse> {
		return jsonRequest<RecipeImportConfirmResponse>('/import/confirm', {
			body: JSON.stringify({recipe}),
			method: 'POST',
		});
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
