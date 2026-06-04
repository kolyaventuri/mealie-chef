import {describe, expect, it, vi} from 'vitest';
import {
	MealieClient,
	ingredientKeyFromParts,
	mapRecipeDetail,
} from './mealie-client';

describe('MealieClient mapping', () => {
	it('maps recipe details and links ingredients to formatted steps', () => {
		const recipe = mapRecipeDetail({
			cookTime: 'PT20M',
			name: 'Vegetable Soup',
			recipeIngredient: [
				{
					display: '2 count Carrot small dice',
					food: {name: 'Carrot'},
					id: 'carrot',
					note: 'small dice',
					quantity: 2,
					unit: {abbreviation: 'ct', name: 'count'},
				},
			],
			recipeInstructions: [
				{
					ingredientReferences: [{referenceId: 'carrot'}],
					text: '**Simmer** until tender.',
					title: 'Cook',
				},
			],
			recipeYield: '4 servings',
			slug: 'vegetable-soup',
			tools: [
				{
					id: 'dutch-oven',
					name: 'Dutch oven',
					slug: 'dutch-oven',
				},
			],
		});

		expect(recipe.ingredients).toEqual([
			expect.objectContaining({
				display: '2 count Carrot',
				key: 'ingredient:carrot',
				linkedStepIndexes: [0],
				note: 'small dice',
			}),
		]);
		expect(recipe.steps).toEqual([
			expect.objectContaining({
				linkedIngredientKeys: ['ingredient:carrot'],
				text: '**Simmer** until tender.',
			}),
		]);
		expect(recipe.tools).toEqual([
			{
				key: 'tool:dutch-oven',
				name: 'Dutch oven',
				slug: 'dutch-oven',
			},
		]);
	});

	it('creates deterministic ingredient keys without upstream ids', () => {
		const parts = {
			display: '1 cup flour',
			food: 'Flour',
			note: '',
			quantity: '1',
			unit: 'cup',
		};

		expect(ingredientKeyFromParts(0, parts)).toBe(
			ingredientKeyFromParts(0, parts),
		);
		expect(ingredientKeyFromParts(1, parts)).not.toBe(
			ingredientKeyFromParts(0, parts),
		);
	});

	it('does not repeat note text when Mealie note duplicates the display', () => {
		const recipe = mapRecipeDetail({
			name: 'Salt',
			recipeIngredient: [
				{
					display: 'salt',
					food: {name: 'salt'},
					note: 'salt',
					quantity: 0,
				},
			],
			recipeInstructions: [],
			slug: 'salt',
		});

		expect(recipe.ingredients[0]).toEqual(
			expect.objectContaining({
				display: 'salt',
				note: undefined,
			}),
		);
	});

	it('sends token-protected Mealie requests and normalizes recipe search results', async () => {
		const fetcher = vi.fn(
			async (
				_input: Parameters<typeof fetch>[0],
				_init?: Parameters<typeof fetch>[1],
			) => {
				return Response.json(
					{
						items: [
							{
								description: 'Weeknight dinner',
								name: 'Pasta',
								slug: 'pasta',
							},
						],
					},
					{
						headers: {
							'content-type': 'application/json',
						},
						status: 200,
					},
				);
			},
		);
		const client = new MealieClient({
			apiToken: 'secret-token',
			baseUrl: 'http://mealie.test',
			fetcher,
		});

		await expect(client.searchRecipes('pasta')).resolves.toEqual([
			{
				description: 'Weeknight dinner',
				name: 'Pasta',
				slug: 'pasta',
				totalTime: undefined,
			},
		]);
		const firstCall = fetcher.mock.calls[0];
		const requestedUrl =
			typeof firstCall[0] === 'string'
				? firstCall[0]
				: firstCall[0] instanceof URL
					? firstCall[0].toString()
					: firstCall[0].url;

		expect(requestedUrl).toContain('/api/recipes');
		expect(requestedUrl).toContain('search=pasta');
		expect(firstCall[1]).toMatchObject({
			headers: expect.objectContaining({
				Authorization: 'Bearer secret-token',
			}),
		});
	});
});
