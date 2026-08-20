import {afterEach, describe, expect, it, vi} from 'vitest';
import type {SchemaOrgRecipe} from '../shared/recipe-import';
import type {AppConfig} from './config';
import {HttpError} from './errors';
import type {MealieClient} from './mealie-client';
import {createApp} from './routes';
import {SessionStore} from './session-store';

const config: AppConfig = {
	databasePath: ':memory:',
	mealieBaseUrl: 'https://mealie.example.test',
	openAiRecipeModel: 'gpt-5.6-luna',
	openAiRecipeReasoningEffort: 'medium',
	port: 0,
	sessionMaxAgeMs: 60 * 60 * 1000,
	staticRoot: '/path/that/does/not/exist',
};

const schemaRecipe: SchemaOrgRecipe = {
	'@context': 'https://schema.org/',
	'@type': 'Recipe',
	name: 'Imported Pasta',
	recipeIngredient: ['200 g pasta'],
	recipeInstructions: [
		{
			'@type': 'HowToStep',
			text: 'Boil the pasta.',
		},
	],
};

const verifiedRecipe = {
	name: schemaRecipe.name,
	slug: 'imported-pasta',
	ingredients: [],
	steps: [],
	tools: [],
};

describe('recipe import routes', () => {
	const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];

	afterEach(async () => {
		await Promise.all(apps.splice(0).map(async (app) => app.close()));
	});

	const createRouteApp = async (options?: {
		ingredientParser?: {
			parseIngredients(inputs: string[]): Promise<{
				ingredients: Array<{
					food?: string;
					note?: string;
					quantity?: number;
					unit?: string;
				}>;
			}>;
		};
		mealie?: Partial<MealieClient>;
		parser?: {
			parse(input: unknown): Promise<{
				recipe: SchemaOrgRecipe;
				reviewNotes: string[];
			}>;
		};
		sourceFetcher?: (url: string) => Promise<{
			canonicalUrl: string;
			jsonLd: string[];
			visibleText: string;
		}>;
	}) => {
		const app = await createApp({
			config,
			mealieClient: {
				configured: true,
				getGroupSlug: vi.fn(async () => 'home'),
				getRecipe: vi.fn(async () => verifiedRecipe),
				importSchemaRecipe: vi.fn(async () => verifiedRecipe.slug),
				parseIngredients: vi.fn(async (ingredients: string[]) =>
					ingredients.map((input, index) => ({
						input,
						ingredient: {
							food: {
								id: `food-${index}`,
								name: input,
							},
							quantity: 1,
							unit: {
								id: `unit-${index}`,
								name: 'count',
							},
						},
					})),
				),
				updateRecipeIngredients: vi.fn(async () => undefined),
				...options?.mealie,
			} as unknown as MealieClient,
			ingredientParser: options?.ingredientParser,
			recipeParser: options?.parser,
			sessionStore: new SessionStore(':memory:'),
			sourceFetcher: options?.sourceFetcher,
		});
		apps.push(app);

		return app;
	};

	it('parses arbitrary text without contacting the URL source fetcher', async () => {
		const parser = {
			parse: vi.fn(async (input: unknown) => {
				expect(input).toEqual({
					mode: 'text',
					text: 'Boil pasta and add sauce.',
				});

				return {
					recipe: schemaRecipe,
					reviewNotes: ['Check the sauce amount.'],
				};
			}),
		};
		const sourceFetcher = vi.fn();
		const app = await createRouteApp({parser, sourceFetcher});

		const response = await app.inject({
			method: 'POST',
			payload: {
				mode: 'text',
				text: 'Boil pasta and add sauce.',
			},
			url: '/import/parse',
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			recipe: schemaRecipe,
			reviewNotes: ['Check the sauce amount.'],
			source: {kind: 'text'},
		});
		expect(parser.parse).toHaveBeenCalledTimes(1);
		expect(sourceFetcher).not.toHaveBeenCalled();
	});

	it('fetches URL source material and preserves its canonical URL', async () => {
		const parser = {
			parse: vi.fn(async (input: unknown) => {
				expect(input).toMatchObject({
					mode: 'url',
					source: {canonicalUrl: 'https://recipes.example.test/pasta'},
				});

				return {recipe: schemaRecipe, reviewNotes: []};
			}),
		};
		const sourceFetcher = vi.fn(async () => ({
			canonicalUrl: 'https://recipes.example.test/pasta',
			jsonLd: [],
			visibleText: 'Pasta recipe',
		}));
		const app = await createRouteApp({parser, sourceFetcher});

		const response = await app.inject({
			method: 'POST',
			payload: {
				mode: 'url',
				url: 'https://recipes.example.test/pasta?source=import',
			},
			url: '/import/parse',
		});

		expect(response.statusCode).toBe(200);
		expect(sourceFetcher).toHaveBeenCalledWith(
			'https://recipes.example.test/pasta?source=import',
		);
		expect(response.json()).toMatchObject({
			recipe: {...schemaRecipe, url: 'https://recipes.example.test/pasta'},
			source: {
				kind: 'url',
				url: 'https://recipes.example.test/pasta',
			},
		});
	});

	it('accepts multiple supported screenshots and rejects unsupported image formats', async () => {
		const parser = {
			parse: vi.fn(async (input: unknown) => {
				expect(input).toMatchObject({
					images: [
						expect.objectContaining({mimeType: 'image/png'}),
						expect.objectContaining({mimeType: 'image/webp'}),
					],
					mode: 'images',
				});

				return {recipe: schemaRecipe, reviewNotes: []};
			}),
		};
		const app = await createRouteApp({parser});
		const boundary = 'recipe-import-test-boundary';
		const multipartBody = [
			`--${boundary}\r\nContent-Disposition: form-data; name="mode"\r\n\r\nimages\r\n`,
			`--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="page-1.png"\r\nContent-Type: image/png\r\n\r\nPNG\r\n`,
			`--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="page-2.webp"\r\nContent-Type: image/webp\r\n\r\nWEBP\r\n`,
			`--${boundary}--\r\n`,
		].join('');

		const response = await app.inject({
			headers: {'content-type': `multipart/form-data; boundary=${boundary}`},
			method: 'POST',
			payload: multipartBody,
			url: '/import/parse',
		});

		expect(response.statusCode).toBe(200);
		expect(parser.parse).toHaveBeenCalledTimes(1);

		const unsupportedBoundary = 'recipe-import-gif-boundary';
		const unsupportedResponse = await app.inject({
			headers: {
				'content-type': `multipart/form-data; boundary=${unsupportedBoundary}`,
			},
			method: 'POST',
			payload: [
				`--${unsupportedBoundary}\r\nContent-Disposition: form-data; name="mode"\r\n\r\nimages\r\n`,
				`--${unsupportedBoundary}\r\nContent-Disposition: form-data; name="images"; filename="page.gif"\r\nContent-Type: image/gif\r\n\r\nGIF\r\n`,
				`--${unsupportedBoundary}--\r\n`,
			].join(''),
			url: '/import/parse',
		});

		expect(unsupportedResponse.statusCode).toBe(415);
		expect(parser.parse).toHaveBeenCalledTimes(1);
	});

	it('requires confirmation, imports the edited draft, and verifies the slug', async () => {
		const importSchemaRecipe = vi.fn(async () => verifiedRecipe.slug);
		const getRecipe = vi.fn(async () => verifiedRecipe);
		const parseIngredients = vi.fn(async () => [
			{
				input: '200 g pasta',
				ingredient: {
					food: {id: 'food-pasta', name: 'pasta'},
					quantity: 200,
					unit: {id: 'unit-gram', name: 'gram'},
				},
			},
		]);
		const updateRecipeIngredients = vi.fn(async () => undefined);
		const app = await createRouteApp({
			mealie: {
				getRecipe,
				importSchemaRecipe,
				parseIngredients,
				updateRecipeIngredients,
			},
		});

		const response = await app.inject({
			method: 'POST',
			payload: {recipe: {...schemaRecipe, name: 'Edited Pasta'}},
			url: '/import/confirm',
		});

		expect(response.statusCode).toBe(200);
		expect(importSchemaRecipe).toHaveBeenCalledWith({
			...schemaRecipe,
			name: 'Edited Pasta',
		});
		expect(parseIngredients).toHaveBeenCalledWith(['200 g pasta']);
		expect(updateRecipeIngredients).toHaveBeenCalledWith(
			'imported-pasta',
			expect.arrayContaining([
				expect.objectContaining({
					ingredient: expect.objectContaining({
						food: {id: 'food-pasta', name: 'pasta'},
						quantity: 200,
						unit: {id: 'unit-gram', name: 'gram'},
					}),
				}),
			]),
		);
		expect(getRecipe).toHaveBeenCalledWith('imported-pasta');
		expect(response.json()).toEqual({
			ingredientParsing: {
				ingredientCount: 1,
				mappedFoodCount: 1,
				mappedUnitCount: 1,
				parsed: true,
			},
			mealieUrl: 'https://mealie.example.test/g/home/r/imported-pasta',
			recipe: verifiedRecipe,
			slug: 'imported-pasta',
		});
	});

	it('keeps the raw ingredient text when Mealie parsing is unavailable', async () => {
		const parseIngredients = vi.fn(async () => {
			throw new HttpError(503, 'Mealie parser unavailable.');
		});
		const updateRecipeIngredients = vi.fn(async () => undefined);
		const app = await createRouteApp({
			mealie: {parseIngredients, updateRecipeIngredients},
		});

		const response = await app.inject({
			method: 'POST',
			payload: {recipe: schemaRecipe},
			url: '/import/confirm',
		});

		expect(response.statusCode).toBe(200);
		expect(parseIngredients).toHaveBeenCalledWith(['200 g pasta']);
		expect(updateRecipeIngredients).not.toHaveBeenCalled();
		expect(response.json()).toMatchObject({
			ingredientParsing: {
				ingredientCount: 1,
				mappedFoodCount: 0,
				mappedUnitCount: 0,
				parsed: false,
				warning: expect.stringContaining('original ingredient text'),
			},
		});
	});

	it('uses the LLM only for unmatched lines, then lets Mealie rematch them', async () => {
		const parseIngredients = vi
			.fn()
			.mockResolvedValueOnce([
				{
					input: '1/4 teaspoon lemon zest',
					ingredient: {
						food: {name: 'lemon zest'},
						quantity: 0.25,
						unit: {name: 'teaspoon'},
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
			])
			.mockResolvedValueOnce([
				{
					input: '0.25 teaspoon lemon zest',
					ingredient: {
						food: {id: 'food-lemon-zest', name: 'lemon zest'},
						quantity: 0.25,
						unit: {id: 'unit-teaspoon', name: 'teaspoon'},
					},
				},
			]);
		const updateRecipeIngredients = vi.fn(async () => undefined);
		const ingredientParser = {
			parseIngredients: vi.fn(async (inputs: string[]) => {
				expect(inputs).toEqual(['1/4 teaspoon lemon zest']);

				return {
					ingredients: [
						{
							food: 'lemon zest',
							quantity: 0.25,
							unit: 'teaspoon',
						},
					],
				};
			}),
		};
		const app = await createRouteApp({
			ingredientParser,
			mealie: {parseIngredients, updateRecipeIngredients},
		});

		const response = await app.inject({
			method: 'POST',
			payload: {
				recipe: {
					...schemaRecipe,
					recipeIngredient: [
						'1/4 teaspoon lemon zest',
						'1 garlic clove, minced',
					],
				},
			},
			url: '/import/confirm',
		});

		expect(response.statusCode).toBe(200);
		expect(ingredientParser.parseIngredients).toHaveBeenCalledTimes(1);
		expect(parseIngredients).toHaveBeenNthCalledWith(2, [
			'0.25 teaspoon lemon zest',
		]);
		expect(updateRecipeIngredients).toHaveBeenCalledWith(
			'imported-pasta',
			expect.arrayContaining([
				expect.objectContaining({
					input: '1/4 teaspoon lemon zest',
					ingredient: expect.objectContaining({
						food: {id: 'food-lemon-zest', name: 'lemon zest'},
						quantity: 0.25,
						unit: {id: 'unit-teaspoon', name: 'teaspoon'},
					}),
				}),
			]),
		);
		expect(response.json()).toMatchObject({
			ingredientParsing: {
				ingredientCount: 2,
				llmParsedCount: 1,
				mappedFoodCount: 2,
				mappedUnitCount: 2,
				parsed: true,
			},
		});
	});

	it('keeps the imported recipe when saving parsed ingredients fails', async () => {
		const updateRecipeIngredients = vi.fn(async () => {
			throw new HttpError(502, 'Mealie recipe update failed.');
		});
		const app = await createRouteApp({
			mealie: {updateRecipeIngredients},
		});

		const response = await app.inject({
			method: 'POST',
			payload: {recipe: schemaRecipe},
			url: '/import/confirm',
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			ingredientParsing: {
				ingredientCount: 1,
				mappedFoodCount: 1,
				mappedUnitCount: 1,
				parsed: false,
				warning: expect.stringContaining('original ingredient text'),
			},
			mealieUrl: 'https://mealie.example.test/g/home/r/imported-pasta',
			slug: 'imported-pasta',
		});
	});

	it('keeps duplicate failures as a retryable response and does not verify a missing slug', async () => {
		const importSchemaRecipe = vi.fn(async () => {
			throw new HttpError(409, 'Mealie already has a recipe with this name.');
		});
		const getRecipe = vi.fn(async () => verifiedRecipe);
		const app = await createRouteApp({
			mealie: {getRecipe, importSchemaRecipe},
		});

		const response = await app.inject({
			method: 'POST',
			payload: {recipe: schemaRecipe},
			url: '/import/confirm',
		});

		expect(response.statusCode).toBe(409);
		expect(response.json()).toMatchObject({
			message: 'Mealie already has a recipe with this name.',
			requestId: expect.any(String),
		});
		expect(getRecipe).not.toHaveBeenCalled();
	});

	it('rejects an invalid edited draft before calling Mealie', async () => {
		const importSchemaRecipe = vi.fn();
		const app = await createRouteApp({
			mealie: {importSchemaRecipe},
		});

		const response = await app.inject({
			method: 'POST',
			payload: {recipe: {...schemaRecipe, recipeInstructions: []}},
			url: '/import/confirm',
		});

		expect(response.statusCode).toBe(400);
		expect(importSchemaRecipe).not.toHaveBeenCalled();
	});
});
