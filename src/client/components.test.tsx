// @vitest-environment jsdom

import {fireEvent, render, screen} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import {FormattedContent} from './formatted-content';
import {IngredientList, StepStack, ToolList, WeekPlanner} from './components';

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
					'### Sauce\n**Whisk** sesame oil\nand tamari\n\n- Ginger\n- Garlic\n\n`low heat`\n\n<script>alert("no")</script>\n\n| A | B |\n| - | - |\n| 1 | 2 |'
				}
			/>,
		);

		expect(screen.getByRole('heading', {name: 'Sauce'})).toBeInTheDocument();
		expect(screen.getByText('Whisk')).toBeInTheDocument();
		expect(screen.getByText('Ginger')).toBeInTheDocument();
		expect(screen.getByText('low heat')).toBeInTheDocument();
		expect(document.querySelector('script')).not.toBeInTheDocument();
		expect(document.querySelector('br')).toBeInTheDocument();
		expect(document.querySelector('table')).toBeInTheDocument();
	});

	it('collapses and restores visible recipe steps', () => {
		const onCollapsedStepChange = vi.fn();

		const {rerender} = render(
			<StepStack
				activeIndex={0}
				collapsedStepIndexes={new Set()}
				steps={[
					{
						index: 0,
						linkedIngredientKeys: [],
						text: 'Chop onions.',
						title: 'Prep',
					},
					{
						index: 1,
						linkedIngredientKeys: [],
						text: 'Simmer sauce.',
					},
				]}
				onCollapsedStepChange={onCollapsedStepChange}
			/>,
		);

		fireEvent.click(screen.getByRole('button', {name: 'Collapse step 1'}));
		expect(onCollapsedStepChange).toHaveBeenCalledWith(0, true);

		rerender(
			<StepStack
				activeIndex={0}
				collapsedStepIndexes={new Set([0])}
				steps={[
					{
						index: 0,
						linkedIngredientKeys: [],
						text: 'Chop onions.',
						title: 'Prep',
					},
					{
						index: 1,
						linkedIngredientKeys: [],
						text: 'Simmer sauce.',
					},
				]}
				onCollapsedStepChange={onCollapsedStepChange}
			/>,
		);

		expect(screen.getByText('Prep')).toBeInTheDocument();
		expect(screen.queryByText('Chop onions.')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', {name: 'Show step 1'}));
		expect(onCollapsedStepChange).toHaveBeenCalledWith(0, false);
	});

	it('renders recipe tools when Mealie provides them', () => {
		render(
			<ToolList
				tools={[
					{
						key: 'tool:large-pot',
						name: 'Large Pot',
						slug: 'large-pot',
					},
				]}
			/>,
		);

		expect(screen.getByRole('region', {name: 'Tools'})).toBeInTheDocument();
		expect(screen.getByText('Large Pot')).toBeInTheDocument();
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
