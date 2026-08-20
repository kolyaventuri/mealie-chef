import {describe, expect, it} from 'vitest';
import {
	normalizeSchemaOrgRecipe,
	validateSchemaOrgRecipe,
} from './recipe-import';

const validRecipe = {
	'@context': 'https://schema.org/',
	'@type': 'Recipe',
	name: 'Tomato Soup',
	recipeIngredient: ['2 tomatoes', '1 cup stock'],
	recipeInstructions: [
		{
			'@type': 'HowToStep',
			text: 'Simmer until tender.',
		},
	],
};

describe('Schema.org recipe normalization', () => {
	it('preserves facts while omitting placeholders and empty optional values', () => {
		const normalized = normalizeSchemaOrgRecipe({
			...validRecipe,
			author: {'@type': 'Person', name: 'Kitchen Test'},
			description: '  A simple soup. ',
			image: 'https://example.com/soup.jpg',
			nutrition: {
				'@type': 'NutritionInformation',
				calories: '120 kcal',
				fatContent: '2 g',
			},
			recipeIngredient: ['2 tomatoes', 'unknown', '  '],
			recipeInstructions: [
				' Simmer until tender. ',
				{'@type': 'HowToStep', text: 'none'},
			],
		});

		expect(normalized).toEqual({
			'@context': 'https://schema.org/',
			'@type': 'Recipe',
			author: {'@type': 'Person', name: 'Kitchen Test'},
			description: 'A simple soup.',
			image: 'https://example.com/soup.jpg',
			name: 'Tomato Soup',
			nutrition: {
				'@type': 'NutritionInformation',
				calories: '120 kcal',
				fatContent: '2 g',
			},
			recipeIngredient: ['2 tomatoes'],
			recipeInstructions: [
				{'@type': 'HowToStep', text: 'Simmer until tender.'},
			],
		});
	});

	it('rejects missing required Schema.org identity and recipe content', () => {
		const result = validateSchemaOrgRecipe({
			name: 'Incomplete',
			recipeIngredient: [],
			recipeInstructions: [],
		});

		expect(result.recipe).toBeUndefined();
		expect(result.errors).toEqual(
			expect.arrayContaining([
				'@context must be https://schema.org/.',
				'@type must be Recipe.',
				'recipeIngredient must be a nonempty array.',
				'recipeInstructions must be a nonempty array.',
			]),
		);
	});

	it('flags markup and nutrition context for review', () => {
		const result = validateSchemaOrgRecipe({
			...validRecipe,
			nutrition: {
				'@type': 'NutritionInformation',
				calories: '300 kcal',
			},
			recipeInstructions: [
				{'@type': 'HowToStep', text: '<strong>Stir</strong> well.'},
			],
		});

		expect(result.recipe).toBeDefined();
		expect(result.warnings).toEqual(
			expect.arrayContaining([
				expect.stringContaining('contains HTML or Markdown'),
				expect.stringContaining('nutrition is present without recipeYield'),
			]),
		);
	});

	it('normalizes human-readable recipe durations to ISO 8601', () => {
		const result = validateSchemaOrgRecipe({
			...validRecipe,
			prepTime: 'about 15 minutes',
			cookTime: '45 minutes',
			totalTime: '1 hour and 20 minutes',
		});

		expect(result.errors).toEqual([]);
		expect(result.recipe).toMatchObject({
			cookTime: 'PT45M',
			prepTime: 'PT15M',
			totalTime: 'PT1H20M',
		});
	});

	it('keeps malformed optional publication dates out of hard failures', () => {
		const result = validateSchemaOrgRecipe({
			...validRecipe,
			datePublished: '2026/08/19',
			prepTime: 'forty-five minutes',
		});

		expect(result.errors).toEqual(
			expect.arrayContaining([
				'prepTime must be an ISO 8601 duration such as PT45M.',
			]),
		);
		expect(result.errors).not.toContain('datePublished must use YYYY-MM-DD.');
		expect(result.warnings).toContain(
			'datePublished was omitted because the source used an unsupported date format.',
		);
	});

	it('normalizes common JSON-LD date-time metadata to a date-only value', () => {
		const result = validateSchemaOrgRecipe({
			...validRecipe,
			datePublished: '2026-08-19T12:30:00Z',
		});

		expect(result.errors).toEqual([]);
		expect(result.recipe?.datePublished).toBe('2026-08-19');
		expect(result.warnings).not.toContain(
			'datePublished was omitted because the source used an unsupported date format.',
		);
	});
});
