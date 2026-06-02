// @vitest-environment jsdom

import {fireEvent, render, screen} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import {FormattedContent} from './formatted-content';
import {IngredientList, WeekPlanner} from './components';

describe('client components', () => {
	it('renders week planner recipes and starts a selected recipe', () => {
		const onStartRecipe = vi.fn();

		render(
			<WeekPlanner
				days={[
					{
						date: '2026-06-02',
						entries: [
							{
								date: '2026-06-02',
								id: 'dinner',
								mealType: 'Dinner',
								recipe: {
									name: 'Soup',
									slug: 'soup',
								},
							},
						],
						isToday: true,
					},
				]}
				onStartRecipe={onStartRecipe}
			/>,
		);

		fireEvent.click(screen.getByRole('button', {name: /soup/i}));
		expect(onStartRecipe).toHaveBeenCalledWith({
			name: 'Soup',
			slug: 'soup',
		});
	});

	it('sanitizes and renders formatted markdown steps', () => {
		render(
			<FormattedContent
				markdown={
					'**Whisk**\n\n<script>alert("no")</script>\n\n| A | B |\n| - | - |\n| 1 | 2 |'
				}
			/>,
		);

		expect(screen.getByText('Whisk')).toBeInTheDocument();
		expect(document.querySelector('script')).not.toBeInTheDocument();
		expect(document.querySelector('table')).toBeInTheDocument();
	});

	it('supports checking ingredients and displaying source notes', () => {
		const onCheckedChange = vi.fn();

		render(
			<IngredientList
				activeStepIndex={0}
				ingredients={[
					{
						display: 'Salt',
						key: 'ingredient:salt',
						linkedStepIndexes: [0],
						note: 'fine grain',
					},
				]}
				states={{
					'ingredient:salt': {
						checked: false,
						ingredientKey: 'ingredient:salt',
						updatedAt: '2026-06-02T00:00:00.000Z',
					},
				}}
				onCheckedChange={onCheckedChange}
			/>,
		);

		fireEvent.click(screen.getByLabelText('Salt'));

		expect(onCheckedChange).toHaveBeenCalledWith('ingredient:salt', true);
		expect(screen.getByText('fine grain')).toBeInTheDocument();
		expect(screen.queryByPlaceholderText('Note')).not.toBeInTheDocument();
	});
});
