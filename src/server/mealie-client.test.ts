import {describe, expect, it, vi} from 'vitest';
import {
	buildMealieRecipeUrl,
	MealieClient,
	ingredientKeyFromParts,
	mapRecipeDetail,
} from './mealie-client';

describe('MealieClient mapping', () => {
	it('keeps numeric servings when Mealie returns an empty yield', () => {
		const recipe = mapRecipeDetail({
			name: 'Bread',
			slug: 'bread',
			recipeServings: 12,
			recipeYield: '',
			recipeIngredient: [
				{quantity: 50, food: {name: 'flour'}, unit: {name: 'gram'}},
			],
		});
		expect(recipe.recipeServings).toBe(12);
		expect(recipe.ingredients[0]).toMatchObject({
			quantity: '50',
			unit: 'gram',
			food: 'flour',
		});
	});

	it('does not invent a serving count from a non-serving yield', () => {
		expect(
			mapRecipeDetail({name: 'Bread', slug: 'bread', recipeYield: '2 loaves'})
				.recipeServings,
		).toBeUndefined();
	});

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

	it('parses ingredients through Mealie and preserves matched food and unit ids', async () => {
		const fetcher = vi.fn(
			async (
				input: Parameters<typeof fetch>[0],
				init?: Parameters<typeof fetch>[1],
			) => {
				const url =
					typeof input === 'string'
						? input
						: input instanceof URL
							? input.toString()
							: input.url;

				if (url.endsWith('/api/parser/ingredients')) {
					return Response.json([
						{
							confidence: {average: 1},
							input: '1/4 teaspoon lemon zest',
							ingredient: {
								food: {id: 'food-lemon-zest', name: 'lemon zest'},
								quantity: 0.25,
								unit: {id: 'unit-teaspoon', name: 'teaspoon'},
							},
						},
						{
							input: '1 garlic clove, minced',
							ingredient: {
								food: {id: 'food-garlic', name: 'garlic'},
								note: 'minced',
								quantity: 1,
								unit: {id: 'unit-clove', name: 'clove'},
							},
						},
					]);
				}

				expect(url).toBe('http://mealie.test/api/recipes/lemon-pasta');
				expect(init).toMatchObject({method: 'PATCH'});

				return new Response(null, {status: 204});
			},
		);
		const client = new MealieClient({
			apiToken: 'secret-token',
			baseUrl: 'http://mealie.test',
			fetcher,
		});
		const ingredients = ['1/4 teaspoon lemon zest', '1 garlic clove, minced'];

		const parsed = await client.parseIngredients(ingredients);

		expect(parsed).toEqual([
			expect.objectContaining({
				input: ingredients[0],
				ingredient: expect.objectContaining({
					food: {id: 'food-lemon-zest', name: 'lemon zest'},
					quantity: 0.25,
					unit: {id: 'unit-teaspoon', name: 'teaspoon'},
				}),
			}),
			expect.objectContaining({
				input: ingredients[1],
				ingredient: expect.objectContaining({
					food: {id: 'food-garlic', name: 'garlic'},
					note: 'minced',
				}),
			}),
		]);

		await client.updateRecipeIngredients('lemon-pasta', parsed);

		const parserRequest = fetcher.mock.calls[0]?.[1];
		expect(parserRequest).toMatchObject({
			method: 'POST',
		});
		expect(JSON.parse(parserRequest?.body as string)).toEqual({
			ingredients,
			parser: 'nlp',
		});
		const updateRequest = fetcher.mock.calls[1]?.[1];
		expect(JSON.parse(updateRequest?.body as string)).toEqual({
			recipeIngredient: [
				{
					food: {id: 'food-lemon-zest', name: 'lemon zest'},
					originalText: '1/4 teaspoon lemon zest',
					quantity: 0.25,
					unit: {id: 'unit-teaspoon', name: 'teaspoon'},
				},
				{
					food: {id: 'food-garlic', name: 'garlic'},
					note: 'minced',
					originalText: '1 garlic clove, minced',
					quantity: 1,
					unit: {id: 'unit-clove', name: 'clove'},
				},
			],
		});
	});

	it('creates only unmatched food and unit references before saving', async () => {
		const fetcher = vi.fn(
			async (
				input: Parameters<typeof fetch>[0],
				init?: Parameters<typeof fetch>[1],
			) => {
				const url =
					typeof input === 'string'
						? input
						: input instanceof URL
							? input.toString()
							: input.url;

				if (url.endsWith('/api/parser/ingredients')) {
					return Response.json([
						{
							input: '2 layers raspberry filling',
							ingredient: {
								food: {name: 'raspberry filling'},
								quantity: 2,
								unit: {name: 'layers'},
							},
						},
					]);
				}

				if (url.endsWith('/api/foods')) {
					expect(init).toMatchObject({method: 'POST'});

					return Response.json({
						id: 'food-raspberry-filling',
						name: 'raspberry filling',
					});
				}

				if (url.endsWith('/api/units')) {
					expect(init).toMatchObject({method: 'POST'});

					return Response.json({id: 'unit-layers', name: 'layers'});
				}

				expect(url).toBe('http://mealie.test/api/recipes/raspberry-cake');
				expect(init).toMatchObject({method: 'PATCH'});

				return new Response(null, {status: 204});
			},
		);
		const client = new MealieClient({
			apiToken: 'secret-token',
			baseUrl: 'http://mealie.test',
			fetcher,
		});
		const parsed = await client.parseIngredients([
			'2 layers raspberry filling',
		]);

		await client.updateRecipeIngredients('raspberry-cake', parsed);

		expect(JSON.parse(fetcher.mock.calls[1]?.[1]?.body as string)).toEqual({
			name: 'raspberry filling',
		});
		expect(JSON.parse(fetcher.mock.calls[2]?.[1]?.body as string)).toEqual({
			name: 'layers',
		});
		expect(JSON.parse(fetcher.mock.calls[3]?.[1]?.body as string)).toEqual({
			recipeIngredient: [
				{
					food: {
						id: 'food-raspberry-filling',
						name: 'raspberry filling',
					},
					originalText: '2 layers raspberry filling',
					quantity: 2,
					unit: {id: 'unit-layers', name: 'layers'},
				},
			],
		});
	});

	it('posts a Schema.org recipe to Mealie and reads the returned slug', async () => {
		const fetcher = vi.fn(
			async (
				_input: Parameters<typeof fetch>[0],
				_init?: Parameters<typeof fetch>[1],
			) => Response.json({slug: 'lemon-pasta'}, {status: 200}),
		);
		const client = new MealieClient({
			apiToken: 'secret-token',
			baseUrl: 'http://mealie.test',
			fetcher,
		});

		await expect(
			client.importSchemaRecipe({
				'@context': 'https://schema.org/',
				'@type': 'Recipe',
				name: 'Lemon Pasta',
				recipeIngredient: ['200 g pasta'],
				recipeInstructions: [{'@type': 'HowToStep', text: 'Boil the pasta.'}],
			}),
		).resolves.toBe('lemon-pasta');

		const [requestUrl, requestInit] = fetcher.mock.calls[0];
		expect(requestUrl).toEqual(
			new URL('http://mealie.test/api/recipes/create/html-or-json'),
		);
		expect(requestInit).toMatchObject({
			method: 'POST',
			headers: expect.objectContaining({
				'Content-Type': 'application/json',
			}),
		});
		expect(JSON.parse(requestInit?.body as string)).toMatchObject({
			includeCategories: false,
			includeTags: false,
		});
	});

	it('reads the current group slug and builds a browser recipe URL', async () => {
		const fetcher = vi.fn(
			async (
				_input: Parameters<typeof fetch>[0],
				_init?: Parameters<typeof fetch>[1],
			) => Response.json({slug: 'family'}, {status: 200}),
		);
		const client = new MealieClient({
			apiToken: 'secret-token',
			baseUrl: 'https://mealie.example.test/mealie/',
			fetcher,
		});

		await expect(client.getGroupSlug()).resolves.toBe('family');
		expect(fetcher.mock.calls[0]?.[0]).toEqual(
			new URL('https://mealie.example.test/api/groups/self'),
		);
		expect(
			buildMealieRecipeUrl(
				'https://mealie.example.test/mealie/',
				'family',
				'lemon-pasta',
			),
		).toBe('https://mealie.example.test/mealie/g/family/r/lemon-pasta');
	});
});
