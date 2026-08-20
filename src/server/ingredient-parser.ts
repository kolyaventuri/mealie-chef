import type {
	RecipeImportIngredientParsing,
	SchemaOrgRecipe,
} from '../shared/recipe-import';
import type {MealieClient, ParsedMealieIngredient} from './mealie-client';
import type {IngredientParser, ParsedRecipeIngredient} from './recipe-parser';

export const hasMealieId = (value: {id?: string} | undefined): boolean =>
	Boolean(value?.id);

export const summarizeParsedIngredients = (
	parsedIngredients: ParsedMealieIngredient[],
	llmParsedCount = 0,
	warning?: string,
): RecipeImportIngredientParsing => ({
	ingredientCount: parsedIngredients.length,
	...(llmParsedCount > 0 ? {llmParsedCount} : {}),
	mappedFoodCount: parsedIngredients.filter(({ingredient}) =>
		hasMealieId(ingredient.food),
	).length,
	mappedUnitCount: parsedIngredients.filter(({ingredient}) =>
		hasMealieId(ingredient.unit),
	).length,
	parsed: true,
	...(warning ? {warning} : {}),
});

const hasUnmappedReference = (
	reference: ParsedMealieIngredient['ingredient']['food'],
): boolean => Boolean(reference && !hasMealieId(reference));

const needsIngredientLlmFallback = (
	parsedIngredient: ParsedMealieIngredient,
): boolean =>
	!hasMealieId(parsedIngredient.ingredient.food) ||
	hasUnmappedReference(parsedIngredient.ingredient.unit);

export const toLlmParsedMealieIngredient = (
	input: string,
	parsed: ParsedRecipeIngredient,
): ParsedMealieIngredient => ({
	input,
	ingredient: {
		...(parsed.food ? {food: {name: parsed.food}} : {}),
		...(parsed.note ? {note: parsed.note} : {}),
		originalText: input,
		...(parsed.quantity === undefined ? {} : {quantity: parsed.quantity}),
		...(parsed.unit ? {unit: {name: parsed.unit}} : {}),
	},
});

const canonicalIngredientText = (
	input: string,
	parsed: ParsedRecipeIngredient,
): string => {
	const base = [
		parsed.quantity === undefined ? undefined : String(parsed.quantity),
		parsed.unit,
		parsed.food,
	]
		.filter((part): part is string => Boolean(part?.trim()))
		.join(' ');

	if (!base) {
		return input;
	}

	return parsed.note ? `${base}, ${parsed.note}` : base;
};

const firstDefined = <Value>(
	...values: Array<Value | undefined>
): Value | undefined => values.find((value) => value !== undefined);

const mergeIngredientReference = (
	originalReference: ParsedMealieIngredient['ingredient']['food'],
	reparsedReference: ParsedMealieIngredient['ingredient']['food'],
	llmName: string | undefined,
) => {
	if (hasMealieId(reparsedReference)) {
		return reparsedReference;
	}

	if (hasMealieId(originalReference)) {
		return originalReference;
	}

	return (
		reparsedReference ??
		originalReference ??
		(llmName ? {name: llmName} : undefined)
	);
};

const mergeLlmIngredient = (
	original: ParsedMealieIngredient,
	reparsed: ParsedMealieIngredient | undefined,
	llmParsed: ParsedRecipeIngredient,
	input: string,
): ParsedMealieIngredient => {
	const originalIngredient = original.ingredient;
	const reparsedIngredient = reparsed?.ingredient;

	return {
		confidence: reparsed?.confidence ?? original.confidence,
		input,
		ingredient: {
			display: firstDefined(
				originalIngredient.display,
				reparsedIngredient?.display,
			),
			food: mergeIngredientReference(
				originalIngredient.food,
				reparsedIngredient?.food,
				llmParsed.food,
			),
			note: firstDefined(
				reparsedIngredient?.note,
				originalIngredient.note,
				llmParsed.note,
			),
			originalText: input,
			quantity: firstDefined(
				reparsedIngredient?.quantity,
				originalIngredient.quantity,
				llmParsed.quantity,
			),
			referenceId: firstDefined(
				reparsedIngredient?.referenceId,
				originalIngredient.referenceId,
			),
			title: firstDefined(reparsedIngredient?.title, originalIngredient.title),
			unit: mergeIngredientReference(
				originalIngredient.unit,
				reparsedIngredient?.unit,
				llmParsed.unit,
			),
		},
	};
};

export const refineIngredientsWithLlm = async ({
	ingredientParser,
	mealie,
	parsedIngredients,
	recipe,
}: {
	ingredientParser: IngredientParser;
	mealie: MealieClient;
	parsedIngredients: ParsedMealieIngredient[];
	recipe: SchemaOrgRecipe;
}): Promise<{
	llmParsedCount: number;
	parsedIngredients: ParsedMealieIngredient[];
}> => {
	const unresolved = parsedIngredients.flatMap((parsedIngredient, index) =>
		needsIngredientLlmFallback(parsedIngredient)
			? [{index, input: recipe.recipeIngredient[index]}]
			: [],
	);

	if (unresolved.length === 0) {
		return {llmParsedCount: 0, parsedIngredients};
	}

	const llmResult = await ingredientParser.parseIngredients(
		unresolved.map(({input}) => input),
	);
	let reparsed: ParsedMealieIngredient[] | undefined;
	const canonicalInputs = llmResult.ingredients.map((ingredient, index) =>
		canonicalIngredientText(unresolved[index].input, ingredient),
	);

	try {
		reparsed = await mealie.parseIngredients(canonicalInputs);
	} catch {
		// The LLM result is still useful when Mealie cannot parse the canonical form.
	}

	const refined = [...parsedIngredients];

	for (const [position, unresolvedIngredient] of unresolved.entries()) {
		const llmParsed = llmResult.ingredients[position];

		if (!llmParsed) {
			continue;
		}

		refined[unresolvedIngredient.index] = mergeLlmIngredient(
			parsedIngredients[unresolvedIngredient.index],
			reparsed?.[position],
			llmParsed,
			unresolvedIngredient.input,
		);
	}

	return {
		llmParsedCount: llmResult.ingredients.length,
		parsedIngredients: refined,
	};
};
