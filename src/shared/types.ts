export type ISODate = `${number}-${number}-${number}`;

export type RecipeSummary = {
	slug: string;
	name: string;
	description?: string;
	image?: string;
	totalTime?: string;
};

export type RecipeIngredient = {
	key: string;
	display: string;
	quantity?: string;
	unit?: string;
	food?: string;
	note?: string;
	linkedStepIndexes: number[];
};

export type RecipeStep = {
	index: number;
	title?: string;
	text: string;
	linkedIngredientKeys: string[];
};

export type RecipeTool = {
	key: string;
	name: string;
	slug?: string;
};

export type RecipeDetail = RecipeSummary & {
	recipeYield?: string;
	prepTime?: string;
	cookTime?: string;
	ingredients: RecipeIngredient[];
	steps: RecipeStep[];
	tools: RecipeTool[];
	sourceUrl?: string;
};

export type MealPlanEntry = {
	id: string;
	date: ISODate;
	mealType: string;
	title?: string;
	note?: string;
	recipe?: RecipeSummary;
};

export type PlannerDay = {
	date: ISODate;
	isToday: boolean;
	entries: MealPlanEntry[];
};

export type WeekPlannerResponse = {
	start: ISODate;
	end: ISODate;
	today: ISODate;
	days: PlannerDay[];
};

export type IngredientState = {
	ingredientKey: string;
	checked: boolean;
	updatedAt: string;
};

export type CookingSession = {
	id: string;
	recipeSlug: string;
	recipeName: string;
	activeStepIndex: number;
	ingredientKeys: string[];
	ingredientStates: Record<string, IngredientState>;
	revision: number;
	createdAt: string;
	updatedAt: string;
};

export type SetActiveStepPatch = {
	type: 'set-active-step';
	activeStepIndex: number;
};

export type SetIngredientCheckedPatch = {
	type: 'set-ingredient-checked';
	ingredientKey: string;
	checked: boolean;
};

export type SessionMutation = SetActiveStepPatch | SetIngredientCheckedPatch;

export type SessionPatch = SessionMutation & {
	revision: number;
	updatedAt: string;
};

export type SessionSnapshotMessage = {
	type: 'snapshot';
	session: CookingSession;
};

export type SessionPatchMessage = {
	type: 'patch';
	patch: SessionPatch;
	session: CookingSession;
};

export type SessionPresenceMessage = {
	type: 'presence';
	count: number;
};

export type SessionErrorMessage = {
	type: 'error';
	message: string;
};

export type ClientSessionMessage = {
	type: 'patch';
	patch: SessionMutation;
};

export type ServerSessionMessage =
	| SessionSnapshotMessage
	| SessionPatchMessage
	| SessionPresenceMessage
	| SessionErrorMessage;
