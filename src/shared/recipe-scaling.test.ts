import {describe, expect, it} from 'vitest';
import type {RecipeIngredient} from './types';
import {
	formatQuantity,
	getRecipeServings,
	scaledIngredientDisplay,
} from './recipe-scaling';

describe('recipe scaling', () => {
	it.each([
		[4, '', 4],
		['6', '2 loaves', 6],
		[4, '8 servings', 4],
		[0, '4 servings', 4],
		[undefined, '2.5', 2.5],
		[undefined, '6 people', 6],
		[0, '', undefined],
		[undefined, '4–6 servings', undefined],
		[undefined, '2 loaves', undefined],
		[undefined, '12 cookies', undefined],
		[undefined, '0 servings', undefined],
		[-1, undefined, undefined],
		[Number.POSITIVE_INFINITY, undefined, undefined],
	])(
		'resolves servings %s and yield %s to %s',
		(servings, yieldText, expected) => {
			expect(getRecipeServings(servings, yieldText)).toBe(expected);
		},
	);

	it.each([
		[1.5, 'cup', '1 ½'],
		[1 / 3, 'teaspoon', '⅓'],
		[0.125, 'cup', '⅛'],
		[0.666_666, 'cup', '⅔'],
		[2.000_000_01, 'cup', '2'],
		[0.1875, 'teaspoon', '0.19'],
		[(50 * 5) / 12, 'gram', '20.83'],
		[1.5, 'kg', '1.5'],
		[0.003_125, 'teaspoon', '0.0031'],
	])('formats %s %s as %s', (quantity, unit, expected) => {
		expect(formatQuantity(quantity, unit)).toBe(expected);
	});

	const ingredient: RecipeIngredient = {
		key: 'walnuts',
		display: '1 cup walnuts',
		quantity: '1',
		unit: 'cup',
		food: 'walnuts',
		note: 'chopped',
		linkedStepIndexes: [0],
	};

	it('scales from the original quantity without changing recipe data', () => {
		const original = structuredClone(ingredient);
		expect(scaledIngredientDisplay(ingredient, 1.5)).toBe('1 ½ cup walnuts');
		expect(scaledIngredientDisplay(ingredient, 0.25)).toBe('¼ cup walnuts');
		expect(scaledIngredientDisplay(ingredient, 1)).toBe('1 cup walnuts');
		expect(ingredient).toEqual(original);
	});

	it('formats parsed quantities at the original serving count too', () => {
		expect(
			scaledIngredientDisplay({...ingredient, quantity: '0.3333333333333333'}),
		).toBe('⅓ cup walnuts');
	});

	it.each([
		{quantity: '0', display: 'Salt to taste'},
		{quantity: undefined, display: '1–2 cups as needed'},
		{quantity: '1/2', display: '½ cup as needed'},
		{quantity: '1', food: undefined, display: '2 (400 g) cans tomatoes'},
		{disableAmount: true, display: 'Salt to taste'},
	])('preserves amounts that cannot be safely scaled: %s', (overrides) => {
		const unscaled = {...ingredient, ...overrides};
		expect(scaledIngredientDisplay(unscaled, 2)).toBe(unscaled.display);
	});
});
