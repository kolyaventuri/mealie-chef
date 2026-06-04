import {
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Circle,
	Play,
	Search,
	Wrench,
} from 'lucide-react';
import type {
	IngredientState,
	MealPlanEntry,
	PlannerDay,
	RecipeIngredient,
	RecipeStep,
	RecipeTool,
	RecipeSummary,
} from '../shared/types';
import {FormattedContent} from './formatted-content';

export type WeekPlannerProps = {
	days: PlannerDay[];
	onStartRecipe(recipe: RecipeSummary): void;
};

export const WeekPlanner = ({days, onStartRecipe}: WeekPlannerProps) => (
	<div className="week-grid" aria-label="Week planner">
		{days.map((day) => (
			<section
				className={`day-panel ${day.isToday ? 'is-today' : ''}`}
				key={day.date}
			>
				<header className="day-panel__header">
					<div className="day-panel__date">
						<strong>
							{new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, {
								weekday: 'short',
							})}
						</strong>
						<span>{day.date.slice(5)}</span>
					</div>
					{day.isToday ? <span className="today-pill">Today</span> : null}
				</header>
				<div className="day-panel__entries">
					{day.entries.length > 0 ? (
						day.entries.map((entry) => (
							<MealPlanRecipeButton
								entry={entry}
								key={entry.id}
								onStartRecipe={onStartRecipe}
							/>
						))
					) : (
						<p className="day-panel__empty">No meals</p>
					)}
				</div>
			</section>
		))}
	</div>
);

type MealPlanRecipeButtonProps = {
	entry: MealPlanEntry;
	onStartRecipe(recipe: RecipeSummary): void;
};

const MealPlanRecipeButton = ({
	entry,
	onStartRecipe,
}: MealPlanRecipeButtonProps) => {
	if (!entry.recipe) {
		return (
			<div className="plan-entry">
				<span className="plan-entry__text">
					<span className="plan-entry__meal">{entry.mealType}</span>
					<strong>{entry.title ?? entry.note ?? 'Meal'}</strong>
				</span>
			</div>
		);
	}

	const {recipe} = entry;

	return (
		<button
			className="plan-entry plan-entry--button"
			type="button"
			onClick={() => {
				onStartRecipe(recipe);
			}}
		>
			<span className="plan-entry__text">
				<span className="plan-entry__meal">{entry.mealType}</span>
				<strong>{recipe.name}</strong>
			</span>
			<Play aria-hidden="true" size={18} />
		</button>
	);
};

export type RecipeSearchProps = {
	isLoading: boolean;
	onQueryChange(query: string): void;
	onSearch(): void;
	onStartRecipe(recipe: RecipeSummary): void;
	query: string;
	recipes: RecipeSummary[];
};

export const RecipeSearch = ({
	isLoading,
	onQueryChange,
	onSearch,
	onStartRecipe,
	query,
	recipes,
}: RecipeSearchProps) => (
	<section className="search-panel" aria-label="Recipe search">
		<header className="search-panel__header">
			<div>
				<h2>Recipes</h2>
				<p>Search Mealie</p>
			</div>
		</header>
		<form
			className="search-form"
			onSubmit={(event) => {
				event.preventDefault();
				onSearch();
			}}
		>
			<label className="sr-only" htmlFor="recipe-search">
				Search recipes
			</label>
			<input
				autoComplete="off"
				id="recipe-search"
				onChange={(event) => {
					onQueryChange(event.currentTarget.value);
				}}
				placeholder="Search recipes"
				type="search"
				value={query}
			/>
			<button
				className="button button--primary"
				disabled={isLoading}
				type="submit"
			>
				<Search aria-hidden="true" size={18} />
				Search
			</button>
		</form>
		<div className="search-results">
			{recipes.length > 0 ? (
				recipes.map((recipe) => (
					<button
						className="recipe-row"
						key={recipe.slug}
						type="button"
						onClick={() => {
							onStartRecipe(recipe);
						}}
					>
						<span>
							<strong>{recipe.name}</strong>
							{recipe.description ? <small>{recipe.description}</small> : null}
						</span>
						<Play aria-hidden="true" size={18} />
					</button>
				))
			) : (
				<p className="search-results__empty">Search by name or ingredient.</p>
			)}
		</div>
	</section>
);

export type StepStackProps = {
	activeIndex: number;
	collapsedStepIndexes: Set<number>;
	onCollapsedStepChange(stepIndex: number, isCollapsed: boolean): void;
	steps: RecipeStep[];
};

export const StepStack = ({
	activeIndex,
	collapsedStepIndexes,
	onCollapsedStepChange,
	steps,
}: StepStackProps) => {
	const visibleSteps = steps.filter(
		(step) => Math.abs(step.index - activeIndex) <= 1,
	);

	return (
		<div className="step-stack" aria-label="Recipe steps">
			{visibleSteps.map((step) => {
				const isCollapsed = collapsedStepIndexes.has(step.index);

				return (
					<article
						className={`step-panel ${step.index === activeIndex ? 'is-active' : ''} ${isCollapsed ? 'is-collapsed' : ''}`}
						key={step.index}
					>
						<header className="step-panel__header">
							<button
								aria-expanded={!isCollapsed}
								aria-label={`${isCollapsed ? 'Show' : 'Collapse'} step ${step.index + 1}`}
								className="step-panel__toggle"
								type="button"
								onClick={() => {
									onCollapsedStepChange(step.index, !isCollapsed);
								}}
							>
								<span>Step {step.index + 1}</span>
								{step.title ? <strong>{step.title}</strong> : null}
								{isCollapsed ? (
									<ChevronRight aria-hidden="true" size={18} />
								) : (
									<ChevronDown aria-hidden="true" size={18} />
								)}
							</button>
						</header>
						{isCollapsed ? null : (
							<FormattedContent
								className="formatted-step"
								markdown={step.text}
							/>
						)}
					</article>
				);
			})}
		</div>
	);
};

export type ToolListProps = {
	tools: RecipeTool[];
};

export const ToolList = ({tools}: ToolListProps) => {
	if (tools.length === 0) {
		return null;
	}

	return (
		<section className="tools-region" aria-label="Tools">
			<header className="tools-region__header">
				<div>
					<Wrench aria-hidden="true" size={17} />
					<h2>Tools</h2>
				</div>
				<span>{tools.length}</span>
			</header>
			<ul className="tool-list">
				{tools.map((tool) => (
					<li className="tool-chip" key={tool.key}>
						<Wrench aria-hidden="true" size={15} />
						<span>{tool.name}</span>
					</li>
				))}
			</ul>
		</section>
	);
};

export type IngredientListProps = {
	activeStepIndex: number;
	ingredients: RecipeIngredient[];
	onCheckedChange(ingredientKey: string, checked: boolean): void;
	states: Record<string, IngredientState>;
};

export const IngredientList = ({
	activeStepIndex,
	ingredients,
	onCheckedChange,
	states,
}: IngredientListProps) => (
	<div className="ingredient-list" aria-label="Ingredients">
		{ingredients.map((ingredient) => {
			const checked = states[ingredient.key]?.checked ?? false;
			const isLinked = ingredient.linkedStepIndexes.includes(activeStepIndex);

			return (
				<section
					className={`ingredient-row ${checked ? 'is-checked' : ''} ${isLinked ? 'is-linked' : ''}`}
					key={ingredient.key}
				>
					<label className="ingredient-row__check">
						<input
							checked={checked}
							onChange={(event) => {
								onCheckedChange(ingredient.key, event.currentTarget.checked);
							}}
							type="checkbox"
						/>
						{checked ? (
							<CheckCircle2 aria-hidden="true" size={22} />
						) : (
							<Circle aria-hidden="true" size={22} />
						)}
						<span>{ingredient.display}</span>
					</label>
					{ingredient.note ? (
						<p className="ingredient-row__source-note">{ingredient.note}</p>
					) : null}
				</section>
			);
		})}
	</div>
);
