import type {RecipeIngredient} from './types';

export const isValidServings = (value: unknown): value is number =>
	typeof value === 'number' &&
	Number.isFinite(value) &&
	value > 0 &&
	value <= Number.MAX_SAFE_INTEGER;

export const getRecipeServings = (
	servings: unknown,
	yieldText: unknown,
): number | undefined => {
	const count =
		typeof servings === 'string' && servings.trim()
			? Number(servings)
			: servings;

	if (isValidServings(count)) {
		return count;
	}

	// Older recipes may only have a yield string. Do not treat loaves,
	// ranges, or other arbitrary yields as a number of people.
	const match =
		typeof yieldText === 'string'
			? /^\s*(\d+(?:\.\d+)?)\s*(?:servings?|people|persons?)?\s*$/i.exec(
					yieldText,
				)
			: undefined;
	const fallback = match ? Number(match[1]) : undefined;

	return isValidServings(fallback) ? fallback : undefined;
};

const fractions: Array<[number, string]> = [
	[1 / 8, '⅛'],
	[1 / 4, '¼'],
	[1 / 3, '⅓'],
	[3 / 8, '⅜'],
	[1 / 2, '½'],
	[5 / 8, '⅝'],
	[2 / 3, '⅔'],
	[3 / 4, '¾'],
	[7 / 8, '⅞'],
];

const decimalUnits =
	/^(?:g|kg|mg|ml|cl|dl|l|grams?|kilograms?|milligrams?|millilit(?:er|re)s?|lit(?:er|re)s?)$/i;

export const formatQuantity = (quantity: number, unit = ''): string => {
	if (!decimalUnits.test(unit.trim())) {
		const whole = Math.floor(quantity);
		const fraction = fractions.find(
			([value]) => Math.abs(quantity - whole - value) < 0.002,
		);

		if (fraction) {
			return `${whole || ''}${whole ? ' ' : ''}${fraction[1]}`;
		}
	}

	return new Intl.NumberFormat('en-US', {
		...(quantity > 0 && quantity < 0.01
			? {maximumSignificantDigits: 2}
			: {maximumFractionDigits: 2}),
		useGrouping: false,
	}).format(quantity);
};

export const canScaleIngredient = (ingredient: RecipeIngredient): boolean =>
	!ingredient.disableAmount &&
	Boolean(ingredient.food) &&
	Number.isFinite(Number(ingredient.quantity)) &&
	Number(ingredient.quantity) > 0;

export const scaledIngredientDisplay = (
	ingredient: RecipeIngredient,
	scale = 1,
): string => {
	if (!canScaleIngredient(ingredient)) {
		return ingredient.display;
	}

	const quantity = Number(ingredient.quantity) * scale;

	if (!Number.isFinite(quantity) || quantity <= 0) {
		return ingredient.display;
	}

	return [
		formatQuantity(quantity, ingredient.unit),
		ingredient.unit,
		ingredient.food,
	]
		.filter(Boolean)
		.join(' ');
};
