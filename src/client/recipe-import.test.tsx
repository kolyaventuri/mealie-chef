// @vitest-environment jsdom

import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {SchemaOrgRecipe} from '../shared/recipe-import';
import {RecipeImportPage} from './recipe-import';

const mocks = vi.hoisted(() => ({
	confirmRecipeImport: vi.fn(),
	parseRecipeImport: vi.fn(),
}));

vi.mock('./api', () => ({api: mocks}));

const recipe: SchemaOrgRecipe = {
	'@context': 'https://schema.org/',
	'@type': 'Recipe',
	name: 'Screenshot Pancakes',
	recipeIngredient: ['1 cup flour'],
	recipeInstructions: [
		{
			'@type': 'HowToStep',
			text: 'Mix and cook.',
		},
	],
};

describe('recipe import UI', () => {
	beforeEach(() => {
		mocks.confirmRecipeImport.mockReset();
		mocks.parseRecipeImport.mockReset();
		mocks.parseRecipeImport.mockResolvedValue({
			recipe,
			reviewNotes: ['The screenshot quantity may be hard to read.'],
			source: {kind: 'images'},
			warnings: [],
		});
		mocks.confirmRecipeImport.mockResolvedValue({
			ingredientParsing: {
				ingredientCount: 1,
				mappedFoodCount: 1,
				mappedUnitCount: 1,
				parsed: true,
			},
			mealieUrl: 'https://mealie.example.test/g/home/r/edited-pancakes',
			recipe: {
				...recipe,
				name: 'Edited Pancakes',
				slug: 'edited-pancakes',
			},
			slug: 'edited-pancakes',
		});
		Object.defineProperty(URL, 'createObjectURL', {
			configurable: true,
			value: vi.fn(() => 'blob:recipe-screenshot'),
		});
		Object.defineProperty(URL, 'revokeObjectURL', {
			configurable: true,
			value: vi.fn(),
		});
	});

	it('switches modes, selects multiple screenshots, and waits for review', async () => {
		render(
			<RecipeImportPage
				onBack={vi.fn()}
				onToggleTheme={vi.fn()}
				theme="light"
			/>,
		);

		fireEvent.click(screen.getByRole('tab', {name: /screenshots/i}));
		const fileInput = screen.getByLabelText('Choose screenshots');
		const firstFile = new File(['first'], 'page-1.png', {type: 'image/png'});
		const secondFile = new File(['second'], 'page-2.jpg', {type: 'image/jpeg'});

		fireEvent.change(fileInput, {
			target: {files: [firstFile, secondFile]},
		});

		expect(await screen.findByAltText('Screenshot 1')).toBeInTheDocument();
		expect(screen.getByAltText('Screenshot 2')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', {name: 'Parse recipe'}));
		await waitFor(() => {
			expect(mocks.parseRecipeImport).toHaveBeenCalledWith({
				files: [firstFile, secondFile],
				mode: 'images',
			});
		});

		expect(screen.getByLabelText('Name')).toHaveValue('Screenshot Pancakes');
		expect(
			screen.getByText('The screenshot quantity may be hard to read.'),
		).toBeInTheDocument();
		expect(
			screen.getByRole('button', {name: /confirm and add to mealie/i}),
		).toBeDisabled();
	});

	it('allows editing, requires warning acknowledgment, and confirms once', async () => {
		render(
			<RecipeImportPage
				onBack={vi.fn()}
				onToggleTheme={vi.fn()}
				theme="light"
			/>,
		);

		fireEvent.click(screen.getByRole('tab', {name: /pasted text/i}));
		fireEvent.change(screen.getByLabelText('Recipe text'), {
			target: {value: 'Pancakes: mix flour and cook.'},
		});
		fireEvent.click(screen.getByRole('button', {name: 'Parse recipe'}));
		await screen.findByLabelText('Name');

		fireEvent.change(screen.getByLabelText('Name'), {
			target: {value: 'Edited Pancakes'},
		});
		const confirmButton = screen.getByRole('button', {
			name: /confirm and add to mealie/i,
		});
		expect(confirmButton).toBeDisabled();
		expect(mocks.confirmRecipeImport).not.toHaveBeenCalled();

		fireEvent.click(
			screen.getByRole('checkbox', {name: /reviewed these notes/i}),
		);
		expect(confirmButton).toBeEnabled();
		fireEvent.click(confirmButton);

		await waitFor(() => {
			expect(mocks.confirmRecipeImport).toHaveBeenCalledWith(
				expect.objectContaining({name: 'Edited Pancakes'}),
			);
		});
		expect(await screen.findByText('Verified in Mealie')).toBeInTheDocument();
		expect(screen.getByText('edited-pancakes')).toBeInTheDocument();
		expect(
			screen.getByText(/matched 1 existing food and 1 existing unit/i),
		).toBeInTheDocument();
		expect(screen.getByRole('link', {name: /open in mealie/i})).toHaveAttribute(
			'href',
			'https://mealie.example.test/g/home/r/edited-pancakes',
		);
	});
});
