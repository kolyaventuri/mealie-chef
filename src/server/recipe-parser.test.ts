import {describe, expect, it, vi} from 'vitest';
import OpenAI from 'openai';
import {type RecipeParserClient, OpenAiRecipeParser} from './recipe-parser';

const recipe = {
	'@context': 'https://schema.org/',
	'@type': 'Recipe',
	name: 'Lemon Pasta',
	recipeIngredient: ['200 g pasta', '1 lemon'],
	recipeInstructions: [
		{
			'@type': 'HowToStep',
			text: 'Boil the pasta.',
		},
	],
};

const createClient = (response: unknown): RecipeParserClient => ({
	responses: {
		create: vi.fn(
			async () => response,
		) as RecipeParserClient['responses']['create'],
	},
});

const createParser = (client: RecipeParserClient): OpenAiRecipeParser =>
	new OpenAiRecipeParser({
		client,
		model: 'gpt-5.6-luna',
		reasoningEffort: 'medium',
	});

describe('OpenAI recipe parser', () => {
	it.each([
		{
			upstream: 400,
			status: 502,
			code: 'invalid_json_schema',
			message: 'rejected the parsing request',
		},
		{
			upstream: 401,
			status: 502,
			code: 'invalid_api_key',
			message: 'rejected the server API key',
		},
		{
			upstream: 403,
			status: 502,
			code: 'permission_denied',
			message: 'denied access',
		},
		{
			upstream: 404,
			status: 502,
			code: 'model_not_found',
			message: 'denied access',
		},
		{
			upstream: 429,
			status: 503,
			code: 'insufficient_quota',
			message: 'insufficient quota',
		},
		{
			upstream: 429,
			status: 503,
			code: 'rate_limit_exceeded',
			message: 'OpenAI is rate-limiting',
		},
		{
			upstream: 500,
			status: 503,
			code: 'server_error',
			message: 'temporarily unavailable',
		},
	])(
		'preserves safe SDK diagnostics for upstream $upstream/$code',
		async ({upstream, status, code, message}) => {
			const client = createClient(undefined);
			vi.mocked(client.responses.create).mockRejectedValue(
				OpenAI.APIError.generate(
					upstream,
					{
						error: {
							code,
							message:
								'Sensitive source text and sk-secret must not be logged.',
							param: 'text.format.schema',
							type: 'invalid_request_error',
						},
					},
					'upstream failure',
					new Headers({'x-request-id': 'req_openai_test'}),
				),
			);
			const parser = createParser(client);
			await Promise.all(
				[
					parser.parse({mode: 'text', text: 'Boil pasta.'}),
					parser.parseIngredients(['200 g pasta']),
				].map(async (request) => {
					await expect(request).rejects.toMatchObject({
						statusCode: status,
						message: expect.stringContaining(message),
						openaiStatus: upstream,
						openaiErrorCode: code,
						openaiErrorParam: 'text.format.schema',
						openaiErrorType: 'invalid_request_error',
						openaiRequestId: 'req_openai_test',
					});
					await expect(request).rejects.not.toHaveProperty('cause');
					await expect(request).rejects.not.toHaveProperty('headers');
					await expect(request).rejects.not.toHaveProperty('error');
				}),
			);
		},
	);

	it.each([
		{
			error: new OpenAI.APIConnectionTimeoutError(),
			status: 504,
			message: 'timed out',
		},
		{
			error: new OpenAI.APIConnectionError({}),
			status: 503,
			message: 'could not connect',
		},
		{
			error: new TypeError('Sensitive internal details'),
			status: 500,
			message: 'could not complete',
		},
	])(
		'distinguishes transport and internal failures: $status/$message',
		async ({error, status, message}) => {
			const client = createClient(undefined);
			vi.mocked(client.responses.create).mockRejectedValue(error);
			await expect(
				createParser(client).parse({mode: 'text', text: 'Boil pasta.'}),
			).rejects.toMatchObject({
				statusCode: status,
				message: expect.stringContaining(message),
				openaiErrorName: error.name,
			});
		},
	);

	it('uses the configured model and strict structured output for text', async () => {
		const client = createClient({
			_request_id: 'resp_recipe_import_test',
			output_text: JSON.stringify({
				recipe,
				reviewNotes: ['Check the lemon size.'],
			}),
			usage: {input_tokens: 321, output_tokens: 87},
		});
		const parser = createParser(client);

		await expect(
			parser.parse({
				mode: 'text',
				text: 'Lemon pasta: boil pasta and add lemon.',
			}),
		).resolves.toEqual({
			recipe,
			reviewNotes: ['Check the lemon size.'],
			requestId: 'resp_recipe_import_test',
			usage: {inputTokens: 321, outputTokens: 87},
		});

		const request = vi.mocked(client.responses.create).mock.calls[0][0];
		expect(request).toMatchObject({
			model: 'gpt-5.6-luna',
			reasoning: {effort: 'medium'},
			store: false,
			text: {
				format: {
					name: 'mealie_recipe_import',
					strict: true,
					type: 'json_schema',
				},
			},
		});
		expect(request.text?.format).toMatchObject({
			schema: expect.objectContaining({
				required: expect.arrayContaining(['recipe', 'reviewNotes']),
				properties: expect.objectContaining({
					recipe: expect.objectContaining({
						properties: expect.objectContaining({
							cookTime: expect.objectContaining({
								anyOf: expect.arrayContaining([
									expect.objectContaining({format: 'duration'}),
								]),
							}),
						}),
					}),
				}),
			}),
		});
	});

	it('normalizes human-readable model durations before validation', async () => {
		const client = createClient({
			output_text: JSON.stringify({
				recipe: {
					...recipe,
					cookTime: '45 minutes',
					totalTime: '1 hour and 20 minutes',
				},
				reviewNotes: [],
			}),
		});
		const parser = createParser(client);

		await expect(
			parser.parse({
				mode: 'text',
				text: 'A recipe with a 45 minute cook time.',
			}),
		).resolves.toMatchObject({
			recipe: {
				cookTime: 'PT45M',
				totalTime: 'PT1H20M',
			},
		});
	});

	it('parses unresolved ingredients with one strict structured request', async () => {
		const client = createClient({
			_request_id: 'resp_ingredient_parse_test',
			output_text: JSON.stringify({
				ingredients: [
					{
						food: 'lemon zest',
						note: null,
						quantity: 0.25,
						unit: 'teaspoon',
					},
					{
						food: 'garlic',
						note: 'minced',
						quantity: 1,
						unit: 'clove',
					},
				],
			}),
			usage: {input_tokens: 42, output_tokens: 31},
		});
		const parser = createParser(client);

		await expect(
			parser.parseIngredients([
				'1/4 teaspoon lemon zest',
				'1 garlic clove, minced',
			]),
		).resolves.toEqual({
			ingredients: [
				{food: 'lemon zest', quantity: 0.25, unit: 'teaspoon'},
				{food: 'garlic', note: 'minced', quantity: 1, unit: 'clove'},
			],
			requestId: 'resp_ingredient_parse_test',
			usage: {inputTokens: 42, outputTokens: 31},
		});

		const request = vi.mocked(client.responses.create).mock.calls[0][0];
		expect(request).toMatchObject({
			model: 'gpt-5.6-luna',
			reasoning: {effort: 'medium'},
			store: false,
			text: {
				format: {
					name: 'mealie_ingredient_parse',
					strict: true,
					type: 'json_schema',
				},
			},
		});
		expect(request.text?.format).toMatchObject({
			schema: expect.objectContaining({
				required: ['ingredients'],
			}),
		});
	});

	it('sends JSON-LD and the cleaned page body so structured data is optional', async () => {
		const client = createClient({
			output_text: JSON.stringify({recipe, reviewNotes: []}),
		});
		const parser = createParser(client);

		await parser.parse({
			mode: 'url',
			source: {
				canonicalUrl: 'https://recipes.example.test/lemon-pasta',
				jsonLd: ['{"@type":"Recipe","name":"Incomplete"}'],
				visibleText:
					'Lemon Pasta\nIngredients\n200 g pasta\nBoil the pasta and add lemon.',
			},
		});

		const request = vi.mocked(client.responses.create).mock.calls[0][0];
		if (!Array.isArray(request.input)) {
			throw new TypeError('Expected a URL text input item.');
		}

		const inputItem = request.input[0];
		if (
			!inputItem ||
			typeof inputItem !== 'object' ||
			!('content' in inputItem) ||
			!Array.isArray(inputItem.content)
		) {
			throw new Error('Expected URL input content.');
		}

		const text = inputItem.content[0];
		expect(text).toMatchObject({type: 'input_text'});
		if (!text || typeof text !== 'object' || !('text' in text)) {
			throw new Error('Expected URL source text content.');
		}

		expect(text.text).toContain('Incomplete');
		expect(text.text).toContain('Boil the pasta and add lemon.');
	});

	it('adds every screenshot as an image input part', async () => {
		const client = createClient({
			output_text: JSON.stringify({recipe, reviewNotes: []}),
		});
		const parser = createParser(client);

		await parser.parse({
			images: [
				{data: new Uint8Array([1, 2, 3]), mimeType: 'image/png'},
				{data: new Uint8Array([4, 5, 6]), mimeType: 'image/jpeg'},
			],
			mode: 'images',
		});

		const request = vi.mocked(client.responses.create).mock.calls[0][0];
		if (!Array.isArray(request.input)) {
			throw new TypeError('Expected an array of image input items.');
		}

		const content = request.input[0];
		expect(content).toMatchObject({role: 'user'});
		if (
			!content ||
			typeof content !== 'object' ||
			!('content' in content) ||
			!Array.isArray(content.content)
		) {
			throw new Error('Expected image content parts.');
		}

		expect(content.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					image_url: 'data:image/png;base64,AQID',
					type: 'input_image',
				}),
				expect.objectContaining({
					image_url: 'data:image/jpeg;base64,BAUG',
					type: 'input_image',
				}),
			]),
		);
	});

	it('turns a model refusal into an actionable client error', async () => {
		const parser = createParser(
			createClient({
				output: [
					{
						content: [{type: 'refusal'}],
					},
				],
				output_text: '',
			}),
		);

		await expect(
			parser.parse({mode: 'text', text: 'Not a recipe.'}),
		).rejects.toMatchObject({
			message: expect.stringContaining('could not extract'),
			statusCode: 422,
		});
	});

	it('keeps safe OpenAI metadata when the structured recipe fails validation', async () => {
		const parser = createParser(
			createClient({
				_request_id: 'resp_invalid_recipe_test',
				output_text: JSON.stringify({
					recipe: {...recipe, recipeInstructions: []},
					reviewNotes: [],
				}),
				usage: {input_tokens: 456, output_tokens: 123},
			}),
		);

		await expect(
			parser.parse({mode: 'text', text: 'An incomplete recipe.'}),
		).rejects.toMatchObject({
			message: expect.stringContaining('complete recipe'),
			openaiRequestId: 'resp_invalid_recipe_test',
			usage: {inputTokens: 456, outputTokens: 123},
		});
	});
});
