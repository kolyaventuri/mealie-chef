import {createHash} from 'node:crypto';
import type {
	ISODate,
	MealPlanEntry,
	RecipeDetail,
	RecipeIngredient,
	RecipeStep,
	RecipeSummary,
	RecipeTool,
} from '../shared/types';
import {HttpError, getString, isRecord} from './errors';

type Fetcher = typeof fetch;

export type MealieClientOptions = {
	apiToken?: string;
	baseUrl?: string;
	fetcher?: Fetcher;
};

type RequestOptions = {
	query?: Record<string, string | undefined>;
};

const textFrom = (...values: unknown[]): string | undefined => {
	for (const value of values) {
		const text = getString(value);

		if (text) {
			return text;
		}
	}

	return undefined;
};

const nestedString = (
	value: unknown,
	...keys: string[]
): string | undefined => {
	if (!isRecord(value)) {
		return undefined;
	}

	for (const key of keys) {
		const text = getString(value[key]);

		if (text) {
			return text;
		}
	}

	return undefined;
};

const normalizeItems = (payload: unknown): unknown[] => {
	if (Array.isArray(payload)) {
		return payload;
	}

	if (!isRecord(payload)) {
		return [];
	}

	if (Array.isArray(payload.items)) {
		return payload.items;
	}

	if (Array.isArray(payload.results)) {
		return payload.results;
	}

	return [];
};

const asString = (value: unknown): string | undefined => {
	if (typeof value === 'number') {
		return String(value);
	}

	return getString(value);
};

const normalizeComparableText = (value: string): string =>
	value
		.toLowerCase()
		.replaceAll(/[^\p{Letter}\p{Number}]+/gu, ' ')
		.trim();

const stripNoteFromDisplay = (
	display: string | undefined,
	note: string | undefined,
): {display?: string; note?: string} => {
	if (!display) {
		return {note};
	}

	if (!note) {
		return {display};
	}

	const normalizedDisplay = normalizeComparableText(display);
	const normalizedNote = normalizeComparableText(note);

	if (!normalizedNote || normalizedDisplay === normalizedNote) {
		return {
			display,
		};
	}

	if (!display.toLowerCase().endsWith(note.toLowerCase())) {
		return {
			display,
			note,
		};
	}

	const displayWithoutNote = display
		.slice(0, Math.max(0, display.length - note.length))
		.replace(/[,\s-]+$/u, '')
		.trim();

	return {
		display: displayWithoutNote || display,
		note,
	};
};

export const ingredientKeyFromParts = (
	index: number,
	parts: Record<string, unknown>,
): string => {
	const stableId = asString(parts.id) ?? asString(parts.referenceId);

	if (stableId) {
		return `ingredient:${stableId}`;
	}

	const hash = createHash('sha1')
		.update(
			JSON.stringify({
				display: parts.display,
				food: parts.food,
				index,
				note: parts.note,
				quantity: parts.quantity,
				unit: parts.unit,
			}),
		)
		.digest('hex')
		.slice(0, 12);

	return `ingredient:${index}:${hash}`;
};

const mapRecipeSummary = (payload: unknown): RecipeSummary | undefined => {
	if (!isRecord(payload)) {
		return undefined;
	}

	const slug = textFrom(payload.slug, payload.recipeSlug, payload.id);
	const name = textFrom(payload.name, payload.recipeName, payload.title);

	if (!slug || !name) {
		return undefined;
	}

	return {
		description: textFrom(payload.description),
		image: textFrom(payload.image, payload.imageUrl, payload.recipeImage),
		name,
		slug,
		totalTime: asString(payload.totalTime),
	};
};

const mapIngredient = (
	payload: unknown,
	index: number,
): RecipeIngredient | undefined => {
	if (!isRecord(payload)) {
		return undefined;
	}

	const food =
		nestedString(payload.food, 'name', 'label') ??
		textFrom(payload.food, payload.foodName);
	const unit =
		nestedString(payload.unit, 'name', 'label', 'abbreviation') ??
		textFrom(payload.unit, payload.unitName);
	const quantity = asString(payload.quantity);
	const sourceDisplay = textFrom(payload.display, payload.title, payload.text);
	const {display: splitDisplay, note} = stripNoteFromDisplay(
		sourceDisplay,
		textFrom(payload.note),
	);
	const fallbackDisplay = [quantity, unit, food]
		.filter(Boolean)
		.join(' ')
		.trim();
	const display =
		splitDisplay ?? (fallbackDisplay || `Ingredient ${index + 1}`);

	return {
		display,
		food,
		key: ingredientKeyFromParts(index, {
			display,
			food,
			id: payload.id,
			note,
			quantity,
			referenceId: payload.referenceId,
			unit,
		}),
		linkedStepIndexes: [],
		note,
		quantity,
		unit,
	};
};

const extractIngredientReferences = (payload: unknown): string[] => {
	if (!isRecord(payload)) {
		return [];
	}

	const references =
		payload.ingredientReferences ??
		payload.ingredients ??
		payload.recipeIngredients;

	if (!Array.isArray(references)) {
		return [];
	}

	return references
		.map((reference) => {
			if (isRecord(reference)) {
				return textFrom(
					reference.referenceId,
					reference.ingredientId,
					reference.id,
				);
			}

			return asString(reference);
		})
		.filter((value): value is string => value !== undefined);
};

const mapStep = (payload: unknown, index: number): RecipeStep | undefined => {
	if (!isRecord(payload)) {
		return undefined;
	}

	const text = textFrom(
		payload.text,
		payload.instruction,
		payload.description,
		payload.summary,
	);

	if (!text) {
		return undefined;
	}

	return {
		index,
		linkedIngredientKeys: extractIngredientReferences(payload).map(
			(reference) => `ingredient:${reference}`,
		),
		text,
		title: textFrom(payload.title, payload.name),
	};
};

const toolKeyFromParts = (
	index: number,
	parts: Record<string, unknown>,
): string => {
	const stableId =
		asString(parts.id) ?? asString(parts.slug) ?? asString(parts.referenceId);

	if (stableId) {
		return `tool:${stableId}`;
	}

	const hash = createHash('sha1')
		.update(
			JSON.stringify({
				index,
				name: parts.name,
			}),
		)
		.digest('hex')
		.slice(0, 12);

	return `tool:${index}:${hash}`;
};

const mapTool = (payload: unknown, index: number): RecipeTool | undefined => {
	if (typeof payload === 'string') {
		const name = payload.trim();

		if (!name) {
			return undefined;
		}

		return {
			key: toolKeyFromParts(index, {name}),
			name,
		};
	}

	if (!isRecord(payload)) {
		return undefined;
	}

	const name = textFrom(payload.name, payload.label, payload.title);

	if (!name) {
		return undefined;
	}

	return {
		key: toolKeyFromParts(index, {
			id: payload.id,
			name,
			referenceId: payload.referenceId,
			slug: payload.slug,
		}),
		name,
		slug: textFrom(payload.slug),
	};
};

export const mapRecipeDetail = (payload: unknown): RecipeDetail => {
	if (!isRecord(payload)) {
		throw new HttpError(502, 'Mealie returned an unexpected recipe payload.');
	}

	const summary = mapRecipeSummary(payload);

	if (!summary) {
		throw new HttpError(
			502,
			'Mealie recipe payload did not include a name and slug.',
		);
	}

	const ingredients = normalizeItems(
		payload.recipeIngredient ?? payload.ingredients,
	)
		.map((item, index) => mapIngredient(item, index))
		.filter(
			(ingredient): ingredient is RecipeIngredient => ingredient !== undefined,
		);
	const steps = normalizeItems(
		payload.recipeInstructions ?? payload.instructions ?? payload.steps,
	)
		.map((item, index) => mapStep(item, index))
		.filter((step): step is RecipeStep => step !== undefined);
	const tools = normalizeItems(payload.tools ?? payload.recipeTools)
		.map((item, index) => mapTool(item, index))
		.filter((tool): tool is RecipeTool => tool !== undefined);
	const ingredientKeys = new Set(
		ingredients.map((ingredient) => ingredient.key),
	);

	for (const step of steps) {
		step.linkedIngredientKeys = step.linkedIngredientKeys.filter((key) =>
			ingredientKeys.has(key),
		);

		for (const ingredientKey of step.linkedIngredientKeys) {
			const ingredient = ingredients.find((item) => item.key === ingredientKey);

			if (ingredient && !ingredient.linkedStepIndexes.includes(step.index)) {
				ingredient.linkedStepIndexes.push(step.index);
			}
		}
	}

	return {
		...summary,
		cookTime: asString(payload.cookTime),
		ingredients,
		prepTime: asString(payload.prepTime),
		recipeYield: asString(payload.recipeYield ?? payload.recipeServings),
		sourceUrl: textFrom(payload.orgURL, payload.originalUrl, payload.sourceUrl),
		steps,
		tools,
	};
};

const mapMealPlanEntry = (payload: unknown): MealPlanEntry | undefined => {
	if (!isRecord(payload)) {
		return undefined;
	}

	const date = textFrom(payload.date, payload.startDate);

	if (!date) {
		return undefined;
	}

	const recipePayload = payload.recipe ?? payload.recipeSummary;
	const recipe = mapRecipeSummary(recipePayload);

	return {
		date: date.slice(0, 10) as ISODate,
		id:
			textFrom(payload.id, payload.groupId) ??
			`${date}:${textFrom(payload.entryType, payload.mealType) ?? 'meal'}`,
		mealType:
			textFrom(payload.entryType, payload.mealType, payload.title) ?? 'Meal',
		note: textFrom(payload.note, payload.description),
		recipe,
		title: textFrom(payload.title),
	};
};

export class MealieClient {
	private readonly apiToken?: string;
	private readonly baseUrl?: string;
	private readonly fetcher: Fetcher;

	constructor(options: MealieClientOptions) {
		this.apiToken = options.apiToken;
		this.baseUrl = options.baseUrl;
		this.fetcher = options.fetcher ?? fetch;
	}

	get configured(): boolean {
		return Boolean(this.apiToken && this.baseUrl);
	}

	async getWeekMealPlans(
		start: ISODate,
		end: ISODate,
	): Promise<MealPlanEntry[]> {
		const payload = await this.request('/api/households/mealplans', {
			query: {
				end_date: end,
				endDate: end,
				start_date: start,
				startDate: start,
			},
		});

		return normalizeItems(payload)
			.map((item) => mapMealPlanEntry(item))
			.filter((entry): entry is MealPlanEntry => entry !== undefined);
	}

	async getTodayMealPlans(): Promise<MealPlanEntry[]> {
		const payload = await this.request('/api/households/mealplans/today');

		return normalizeItems(payload)
			.map((item) => mapMealPlanEntry(item))
			.filter((entry): entry is MealPlanEntry => entry !== undefined);
	}

	async searchRecipes(query = ''): Promise<RecipeSummary[]> {
		const payload = await this.request('/api/recipes', {
			query: {
				orderBy: 'name',
				page: '1',
				perPage: '50',
				search: query.trim() || undefined,
			},
		});

		return normalizeItems(payload)
			.map((item) => mapRecipeSummary(item))
			.filter((recipe): recipe is RecipeSummary => recipe !== undefined);
	}

	async getRecipe(slug: string): Promise<RecipeDetail> {
		const payload = await this.request(
			`/api/recipes/${encodeURIComponent(slug)}`,
		);

		return mapRecipeDetail(payload);
	}

	async proxy(path: string): Promise<Response> {
		return this.requestRaw(path);
	}

	private async request(
		pathname: string,
		options: RequestOptions = {},
	): Promise<unknown> {
		const response = await this.requestRaw(pathname, options);

		return response.json();
	}

	private async requestRaw(
		pathname: string,
		options: RequestOptions = {},
	): Promise<Response> {
		if (!this.baseUrl || !this.apiToken) {
			throw new HttpError(
				503,
				'Mealie is not configured. Set MEALIE_BASE_URL and MEALIE_API_TOKEN.',
			);
		}

		const url = new URL(pathname, this.baseUrl);

		for (const [key, value] of Object.entries(options.query ?? {})) {
			if (value) {
				url.searchParams.set(key, value);
			}
		}

		const response = await this.fetcher(url, {
			headers: {
				Accept: 'application/json',
				Authorization: `Bearer ${this.apiToken}`,
			},
		});

		if (!response.ok) {
			throw new HttpError(
				response.status,
				`Mealie request failed: ${response.status} ${response.statusText}`,
			);
		}

		return response;
	}
}
