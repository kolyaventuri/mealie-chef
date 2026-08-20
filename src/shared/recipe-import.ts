import type {RecipeDetail} from './types';

export type RecipeImportMode = 'url' | 'text' | 'images';

export type SchemaOrgAuthor = {
	'@type': 'Organization' | 'Person';
	name: string;
};

export type SchemaOrgTool = {
	'@type': 'HowToTool';
	name: string;
};

export type SchemaOrgNutrition = {
	'@type': 'NutritionInformation';
	calories?: string;
	proteinContent?: string;
	carbohydrateContent?: string;
	fatContent?: string;
};

export type SchemaOrgInstruction = {
	'@type': 'HowToStep';
	text: string;
};

export type SchemaOrgRecipe = {
	'@context': 'https://schema.org' | 'https://schema.org/';
	'@type': 'Recipe';
	name: string;
	description?: string;
	image?: string;
	url?: string;
	author?: SchemaOrgAuthor;
	datePublished?: string;
	prepTime?: string;
	cookTime?: string;
	performTime?: string;
	totalTime?: string;
	recipeYield?: string;
	recipeCategory?: string;
	recipeCuisine?: string;
	keywords?: string;
	suitableForDiet?: string;
	tool?: SchemaOrgTool[];
	recipeIngredient: string[];
	recipeInstructions: SchemaOrgInstruction[];
	nutrition?: SchemaOrgNutrition;
};

export type RecipeValidationResult = {
	errors: string[];
	warnings: string[];
	recipe?: SchemaOrgRecipe;
};

export type RecipeImportSource = {
	kind: RecipeImportMode;
	url?: string;
};

export type RecipeImportParseResponse = {
	recipe: SchemaOrgRecipe;
	reviewNotes: string[];
	warnings: string[];
	source: RecipeImportSource;
};

export type RecipeImportIngredientParsing = {
	ingredientCount: number;
	llmParsedCount?: number;
	mappedFoodCount: number;
	mappedUnitCount: number;
	parsed: boolean;
	warning?: string;
};

export type RecipeImportConfirmResponse = {
	ingredientParsing?: RecipeImportIngredientParsing;
	mealieUrl: string;
	slug: string;
	recipe: RecipeDetail;
};

const durationPattern =
	/^P(?=\d|T\d)(?:\d+(?:\.\d+)?D)?(?:T(?=\d)(?:\d+(?:\.\d+)?H)?(?:\d+(?:\.\d+)?M)?(?:\d+(?:\.\d+)?S)?)?$/u;
const humanDurationPattern =
	/^(?:about\s+|approximately\s+|approx\.?\s+|around\s+|roughly\s+)?(?:(\d+(?:\.\d+)?)\s*(?:days?|d)\s*)?(?:(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|hr|h)\s*)?(?:(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|min|m)\s*)?(?:(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|sec|s)\s*)?$/iu;
const placeholderPattern =
	/^(?:unknown|n\/?a|none|tbd|todo|placeholder|url of (?:the )?image(?: if available)?)$/iu;
const markupPattern = /<[^>]+>|(?:\*\*|__|^#{1,6}\s)|\[[^\]]+\]\([^)]+\)/u;
const datePublishedPattern = /^(\d{4}-\d{2}-\d{2})(?:$|T|\s)/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const cleanString = (value: unknown): string | undefined => {
	if (typeof value !== 'string') {
		return undefined;
	}

	const trimmed = value.trim();

	return trimmed && !placeholderPattern.test(trimmed) ? trimmed : undefined;
};

const isValidDateOnly = (value: string): boolean => {
	const [year, month, day] = value.split('-').map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));

	return (
		date.getUTCFullYear() === year &&
		date.getUTCMonth() === month - 1 &&
		date.getUTCDate() === day
	);
};

const normalizeDatePublished = (value: unknown): string | undefined => {
	const text = cleanString(value);
	const match = text ? datePublishedPattern.exec(text) : undefined;

	if (!match || !isValidDateOnly(match[1])) {
		return undefined;
	}

	return match[1];
};

const normalizeDuration = (value: unknown): string | undefined => {
	const text = cleanString(value);

	if (!text || durationPattern.test(text)) {
		return text;
	}

	const normalizedText = text
		.replaceAll(/[–—]/gu, '-')
		.replaceAll(',', ' ')
		.replaceAll(/\band\b/giu, ' ')
		.replaceAll(/\s+/gu, ' ')
		.trim();
	const match = humanDurationPattern.exec(normalizedText);

	if (!match || match.slice(1).every((part) => part === undefined)) {
		return text;
	}

	const [days, hours, minutes, seconds] = match.slice(1);
	let duration = 'P';

	if (days) {
		duration += `${days}D`;
	}

	if (hours || minutes || seconds) {
		duration += 'T';

		if (hours) {
			duration += `${hours}H`;
		}

		if (minutes) {
			duration += `${minutes}M`;
		}

		if (seconds) {
			duration += `${seconds}S`;
		}
	}

	return duration === 'P' ? text : duration;
};

const cleanHttpUrl = (value: unknown): string | undefined => {
	const text = cleanString(value);

	if (!text) {
		return undefined;
	}

	try {
		const url = new URL(text);

		return url.protocol === 'http:' || url.protocol === 'https:'
			? url.toString()
			: undefined;
	} catch {
		return undefined;
	}
};

const cleanAuthor = (value: unknown): SchemaOrgAuthor | undefined => {
	if (!isRecord(value)) {
		return undefined;
	}

	const name = cleanString(value.name);

	if (!name) {
		return undefined;
	}

	const type = value['@type'];

	if (type !== 'Organization' && type !== 'Person') {
		return undefined;
	}

	return {
		'@type': type,
		name,
	};
};

const cleanTools = (value: unknown): SchemaOrgTool[] | undefined => {
	if (!Array.isArray(value)) {
		return undefined;
	}

	const tools = value
		.map((item) => {
			if (typeof item === 'string') {
				const name = cleanString(item);

				return name ? {'@type': 'HowToTool' as const, name} : undefined;
			}

			if (!isRecord(item)) {
				return undefined;
			}

			const name = cleanString(item.name);

			return name ? {'@type': 'HowToTool' as const, name} : undefined;
		})
		.filter((tool): tool is SchemaOrgTool => tool !== undefined);

	return tools.length > 0 ? tools : undefined;
};

const cleanNutrition = (value: unknown): SchemaOrgNutrition | undefined => {
	if (!isRecord(value) || value['@type'] !== 'NutritionInformation') {
		return undefined;
	}

	const nutrition: SchemaOrgNutrition = {
		'@type': 'NutritionInformation',
	};
	const fields = [
		'calories',
		'proteinContent',
		'carbohydrateContent',
		'fatContent',
	] as const;

	for (const field of fields) {
		const text = cleanString(value[field]);

		if (text) {
			nutrition[field] = text;
		}
	}

	return Object.keys(nutrition).length > 1 ? nutrition : undefined;
};

const cleanInstructions = (value: unknown): SchemaOrgInstruction[] => {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.map((item) => {
			if (typeof item === 'string') {
				const text = cleanString(item);

				return text ? {'@type': 'HowToStep' as const, text} : undefined;
			}

			if (!isRecord(item)) {
				return undefined;
			}

			const text = cleanString(item.text);

			return text ? {'@type': 'HowToStep' as const, text} : undefined;
		})
		.filter((step): step is SchemaOrgInstruction => step !== undefined);
};

const cleanIngredients = (value: unknown): string[] => {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.map((item) => cleanString(item))
		.filter((ingredient): ingredient is string => ingredient !== undefined);
};

export const normalizeSchemaOrgRecipe = (
	value: unknown,
): Partial<SchemaOrgRecipe> => {
	if (!isRecord(value)) {
		return {};
	}

	const recipe: Partial<SchemaOrgRecipe> = {
		name: cleanString(value.name) ?? '',
		recipeIngredient: cleanIngredients(value.recipeIngredient),
		recipeInstructions: cleanInstructions(value.recipeInstructions),
	};
	const context = value['@context'];

	if (context === 'https://schema.org' || context === 'https://schema.org/') {
		recipe['@context'] = context;
	}

	if (value['@type'] === 'Recipe') {
		recipe['@type'] = 'Recipe';
	}

	const stringFields = [
		'description',
		'recipeYield',
		'recipeCategory',
		'recipeCuisine',
		'keywords',
		'suitableForDiet',
	] as const;

	for (const field of stringFields) {
		const text = cleanString(value[field]);

		if (text) {
			recipe[field] = text;
		}
	}

	for (const field of [
		'prepTime',
		'cookTime',
		'performTime',
		'totalTime',
	] as const) {
		const duration = normalizeDuration(value[field]);

		if (duration) {
			recipe[field] = duration;
		}
	}

	const datePublished = normalizeDatePublished(value.datePublished);

	if (datePublished) {
		recipe.datePublished = datePublished;
	}

	const image = cleanHttpUrl(value.image);
	const url = cleanHttpUrl(value.url);

	if (image) {
		recipe.image = image;
	}

	if (url) {
		recipe.url = url;
	}

	const author = cleanAuthor(value.author);
	const tool = cleanTools(value.tool);
	const nutrition = cleanNutrition(value.nutrition);

	if (author) {
		recipe.author = author;
	}

	if (tool) {
		recipe.tool = tool;
	}

	if (nutrition) {
		recipe.nutrition = nutrition;
	}

	return recipe;
};

// Validation intentionally reports each independent field so the review UI can be specific.
// eslint-disable-next-line complexity
export function validateSchemaOrgRecipe(
	value: unknown,
): RecipeValidationResult {
	const normalized = normalizeSchemaOrgRecipe(value);
	const errors: string[] = [];
	const warnings: string[] = [];

	if (
		normalized['@context'] !== 'https://schema.org' &&
		normalized['@context'] !== 'https://schema.org/'
	) {
		errors.push('@context must be https://schema.org/.');
	}

	if (normalized['@type'] !== 'Recipe') {
		errors.push('@type must be Recipe.');
	}

	if (!normalized.name) {
		errors.push('name must be a nonempty string.');
	}

	if (
		!normalized.recipeIngredient ||
		normalized.recipeIngredient.length === 0
	) {
		errors.push('recipeIngredient must be a nonempty array.');
	}

	if (
		!normalized.recipeInstructions ||
		normalized.recipeInstructions.length === 0
	) {
		errors.push('recipeInstructions must be a nonempty array.');
	}

	for (const [index, ingredient] of (
		normalized.recipeIngredient ?? []
	).entries()) {
		if (markupPattern.test(ingredient)) {
			warnings.push(
				`recipeIngredient[${index}] contains HTML or Markdown that Mealie may strip.`,
			);
		}
	}

	for (const [index, step] of (normalized.recipeInstructions ?? []).entries()) {
		if (!step.text) {
			errors.push(
				`recipeInstructions[${index}].text must be a nonempty string.`,
			);
			continue;
		}

		if (markupPattern.test(step.text)) {
			warnings.push(
				`recipeInstructions[${index}].text contains HTML or Markdown that Mealie may strip.`,
			);
		}
	}

	for (const field of [
		'prepTime',
		'cookTime',
		'performTime',
		'totalTime',
	] as const) {
		const valueForField = normalized[field];

		if (valueForField && !durationPattern.test(valueForField)) {
			errors.push(`${field} must be an ISO 8601 duration such as PT45M.`);
		}
	}

	const rawDatePublished = isRecord(value)
		? cleanString(value.datePublished)
		: undefined;

	if (rawDatePublished && !normalized.datePublished) {
		warnings.push(
			'datePublished was omitted because the source used an unsupported date format.',
		);
	}

	if (normalized.nutrition && !normalized.recipeYield) {
		warnings.push(
			'nutrition is present without recipeYield; per-serving context may be unclear.',
		);
	}

	return {
		errors,
		recipe: errors.length === 0 ? (normalized as SchemaOrgRecipe) : undefined,
		warnings,
	};
}
