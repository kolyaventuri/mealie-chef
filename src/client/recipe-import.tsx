/* eslint-disable complexity, @typescript-eslint/no-confusing-void-expression, @typescript-eslint/no-dynamic-delete, unicorn/no-useless-spread */

import {
	ArrowLeft,
	CheckCircle2,
	Clipboard,
	ExternalLink,
	FileImage,
	Loader2,
	Plus,
	Sparkles,
	Trash2,
	Upload,
	X,
} from 'lucide-react';
import {
	useEffect,
	useMemo,
	useState,
	type Dispatch,
	type SetStateAction,
} from 'react';
import {
	type RecipeImportIngredientParsing,
	type RecipeImportMode,
	type SchemaOrgNutrition,
	type SchemaOrgRecipe,
	validateSchemaOrgRecipe,
} from '../shared/recipe-import';
import {api, type RecipeImportRequest} from './api';
import {ThemeToggle, type Theme} from './theme-toggle';

type RecipeImportPageProps = {
	onBack(): void;
	onToggleTheme(): void;
	theme: Theme;
};

type ImportPhase = 'input' | 'parsing' | 'preview' | 'importing' | 'success';

const modes: Array<{
	description: string;
	label: string;
	mode: RecipeImportMode;
}> = [
	{
		description: 'Fetch a public recipe page',
		label: 'Recipe URL',
		mode: 'url',
	},
	{
		description: 'Paste any recipe text',
		label: 'Pasted text',
		mode: 'text',
	},
	{
		description: 'Read one or more screenshots',
		label: 'Screenshots',
		mode: 'images',
	},
];

const acceptedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

const optionalValue = (value: string | undefined): string => value ?? '';

const RecipeTextField = ({
	label,
	onChange,
	value,
}: {
	label: string;
	onChange(value: string): void;
	value: string | undefined;
}) => (
	<label className="import-field">
		<span>{label}</span>
		<input
			onChange={(event) => {
				onChange(event.currentTarget.value);
			}}
			value={optionalValue(value)}
		/>
	</label>
);

const RecipeTextArea = ({
	label,
	onChange,
	value,
}: {
	label: string;
	onChange(value: string): void;
	value: string | undefined;
}) => (
	<label className="import-field import-field--wide">
		<span>{label}</span>
		<textarea
			onChange={(event) => {
				onChange(event.currentTarget.value);
			}}
			rows={4}
			value={optionalValue(value)}
		/>
	</label>
);

const RecipeListEditor = ({
	items,
	onAdd,
	onChange,
	onRemove,
	placeholder,
}: {
	items: string[];
	onAdd(): void;
	onChange(index: number, value: string): void;
	onRemove(index: number): void;
	placeholder: string;
}) => (
	<div className="import-list-editor">
		{items.map((item, index) => (
			<div className="import-list-editor__row" key={index}>
				<input
					aria-label={`${placeholder} ${index + 1}`}
					onChange={(event) => {
						onChange(index, event.currentTarget.value);
					}}
					value={item}
				/>
				<button
					aria-label={`Remove ${placeholder.toLowerCase()} ${index + 1}`}
					className="icon-button icon-button--small"
					title={`Remove ${placeholder.toLowerCase()} ${index + 1}`}
					type="button"
					onClick={() => {
						onRemove(index);
					}}
				>
					<Trash2 aria-hidden="true" size={16} />
					<span className="sr-only">Remove</span>
				</button>
			</div>
		))}
		<button className="button button--quiet" type="button" onClick={onAdd}>
			<Plus aria-hidden="true" size={17} />
			Add {placeholder.toLowerCase()}
		</button>
	</div>
);

const updateStringField = (
	setDraft: Dispatch<SetStateAction<SchemaOrgRecipe | undefined>>,
	field: string,
	value: string,
): void => {
	setDraft((current) => {
		if (!current) {
			return current;
		}

		const next = {...current} as unknown as Record<string, unknown>;

		if (value.trim()) {
			next[field] = value;
		} else {
			delete next[field];
		}

		return next as SchemaOrgRecipe;
	});
};

const updateNutritionField = (
	setDraft: Dispatch<SetStateAction<SchemaOrgRecipe | undefined>>,
	field: keyof Omit<SchemaOrgNutrition, '@type'>,
	value: string,
): void => {
	setDraft((current) => {
		if (!current) {
			return current;
		}

		const nutrition = {
			'@type': 'NutritionInformation' as const,
			...current.nutrition,
		} as unknown as Record<string, unknown>;

		if (value.trim()) {
			nutrition[field] = value;
		} else {
			delete nutrition[field];
		}

		const next = {...current} as unknown as Record<string, unknown>;

		if (Object.keys(nutrition).length > 1) {
			next.nutrition = nutrition;
		} else {
			delete next.nutrition;
		}

		return next as SchemaOrgRecipe;
	});
};

const RecipeDraftEditor = ({
	draft,
	setDraft,
}: {
	draft: SchemaOrgRecipe;
	setDraft: Dispatch<SetStateAction<SchemaOrgRecipe | undefined>>;
}) => {
	const updateList = (
		field: 'recipeIngredient' | 'recipeInstructions',
		index: number,
		value: string,
	) => {
		setDraft((current) => {
			if (!current) {
				return current;
			}

			const nextItems = current[field].map((item, itemIndex) =>
				itemIndex === index
					? field === 'recipeIngredient'
						? value
						: {'@type': 'HowToStep' as const, text: value}
					: item,
			);

			return {...current, [field]: nextItems};
		});
	};

	const removeListItem = (
		field: 'recipeIngredient' | 'recipeInstructions',
		index: number,
	) => {
		setDraft((current) =>
			current
				? {
						...current,
						[field]: current[field].filter(
							(_item, itemIndex) => itemIndex !== index,
						),
					}
				: current,
		);
	};

	const addListItem = (field: 'recipeIngredient' | 'recipeInstructions') => {
		setDraft((current) => {
			if (!current) {
				return current;
			}

			const item =
				field === 'recipeIngredient'
					? ''
					: {'@type': 'HowToStep' as const, text: ''};

			return {
				...current,
				[field]: [...current[field], item],
			};
		});
	};

	const updateTool = (index: number, value: string) => {
		setDraft((current) => {
			if (!current) {
				return current;
			}

			const tools = (current.tool ?? []).map((tool, toolIndex) =>
				toolIndex === index
					? {'@type': 'HowToTool' as const, name: value}
					: tool,
			);

			return {...current, tool: tools};
		});
	};

	const removeTool = (index: number) => {
		setDraft((current) => {
			if (!current) {
				return current;
			}

			const tools = (current.tool ?? []).filter(
				(_tool, toolIndex) => toolIndex !== index,
			);

			if (tools.length === 0) {
				const next = {...current} as unknown as Record<string, unknown>;
				delete next.tool;
				return next as SchemaOrgRecipe;
			}

			return {...current, tool: tools};
		});
	};

	const addTool = () => {
		setDraft((current) =>
			current
				? {
						...current,
						tool: [
							...(current.tool ?? []),
							{'@type': 'HowToTool' as const, name: ''},
						],
					}
				: current,
		);
	};

	return (
		<div className="recipe-draft-editor">
			<section className="import-editor-section">
				<header className="import-editor-section__header">
					<div>
						<h2>Recipe details</h2>
						<p>Correct anything the parser missed before importing.</p>
					</div>
				</header>
				<div className="import-fields-grid">
					<RecipeTextField
						label="Name"
						onChange={(value) => {
							updateStringField(setDraft, 'name', value);
						}}
						value={draft.name}
					/>
					<RecipeTextField
						label="Source URL"
						onChange={(value) => {
							updateStringField(setDraft, 'url', value);
						}}
						value={draft.url}
					/>
					<RecipeTextArea
						label="Description"
						onChange={(value) =>
							updateStringField(setDraft, 'description', value)
						}
						value={draft.description}
					/>
					<RecipeTextField
						label="Author"
						onChange={(value) => {
							if (value.trim()) {
								setDraft((current) =>
									current
										? {
												...current,
												author: {
													'@type': current.author?.['@type'] ?? 'Person',
													name: value,
												},
											}
										: current,
								);
								return;
							}

							setDraft((current) => {
								if (!current) {
									return current;
								}

								const next = {...current} as unknown as Record<string, unknown>;
								delete next.author;
								return next as SchemaOrgRecipe;
							});
						}}
						value={draft.author?.name}
					/>
					<RecipeTextField
						label="Date published"
						onChange={(value) =>
							updateStringField(setDraft, 'datePublished', value)
						}
						value={draft.datePublished}
					/>
					<RecipeTextField
						label="Yield"
						onChange={(value) =>
							updateStringField(setDraft, 'recipeYield', value)
						}
						value={draft.recipeYield}
					/>
					<RecipeTextField
						label="Prep time"
						onChange={(value) => {
							updateStringField(setDraft, 'prepTime', value);
						}}
						value={draft.prepTime}
					/>
					<RecipeTextField
						label="Cook time"
						onChange={(value) => {
							updateStringField(setDraft, 'cookTime', value);
						}}
						value={draft.cookTime}
					/>
					<RecipeTextField
						label="Total time"
						onChange={(value) =>
							updateStringField(setDraft, 'totalTime', value)
						}
						value={draft.totalTime}
					/>
					<RecipeTextField
						label="Category"
						onChange={(value) =>
							updateStringField(setDraft, 'recipeCategory', value)
						}
						value={draft.recipeCategory}
					/>
					<RecipeTextField
						label="Cuisine"
						onChange={(value) =>
							updateStringField(setDraft, 'recipeCuisine', value)
						}
						value={draft.recipeCuisine}
					/>
					<RecipeTextField
						label="Keywords"
						onChange={(value) => {
							updateStringField(setDraft, 'keywords', value);
						}}
						value={draft.keywords}
					/>
					<RecipeTextField
						label="Diet"
						onChange={(value) =>
							updateStringField(setDraft, 'suitableForDiet', value)
						}
						value={draft.suitableForDiet}
					/>
				</div>
			</section>

			<section className="import-editor-section">
				<header className="import-editor-section__header">
					<div>
						<h2>Ingredients</h2>
						<p>Keep one parseable ingredient per line.</p>
					</div>
					<span>{draft.recipeIngredient.length}</span>
				</header>
				<RecipeListEditor
					items={draft.recipeIngredient}
					onAdd={() => {
						addListItem('recipeIngredient');
					}}
					onChange={(index, value) => {
						updateList('recipeIngredient', index, value);
					}}
					onRemove={(index) => {
						removeListItem('recipeIngredient', index);
					}}
					placeholder="Ingredient"
				/>
			</section>

			<section className="import-editor-section">
				<header className="import-editor-section__header">
					<div>
						<h2>Instructions</h2>
						<p>Use chronological, plain-language steps.</p>
					</div>
					<span>{draft.recipeInstructions.length}</span>
				</header>
				<div className="import-list-editor">
					{draft.recipeInstructions.map((step, index) => (
						<div
							className="import-list-editor__row import-list-editor__row--step"
							key={index}
						>
							<textarea
								aria-label={`Instruction ${index + 1}`}
								onChange={(event) => {
									updateList(
										'recipeInstructions',
										index,
										event.currentTarget.value,
									);
								}}
								rows={3}
								value={step.text}
							/>
							<button
								aria-label={`Remove instruction ${index + 1}`}
								className="icon-button icon-button--small"
								title={`Remove instruction ${index + 1}`}
								type="button"
								onClick={() => {
									removeListItem('recipeInstructions', index);
								}}
							>
								<Trash2 aria-hidden="true" size={16} />
								<span className="sr-only">Remove instruction</span>
							</button>
						</div>
					))}
					<button
						className="button button--quiet"
						type="button"
						onClick={() => {
							addListItem('recipeInstructions');
						}}
					>
						<Plus aria-hidden="true" size={17} />
						Add instruction
					</button>
				</div>
			</section>

			<section className="import-editor-section">
				<header className="import-editor-section__header">
					<div>
						<h2>Tools and nutrition</h2>
						<p>Only retain source-provided values.</p>
					</div>
				</header>
				<div className="import-subsection">
					<h3>Tools</h3>
					<div className="import-list-editor">
						{(draft.tool ?? []).map((tool, index) => (
							<div className="import-list-editor__row" key={index}>
								<input
									aria-label={`Tool ${index + 1}`}
									onChange={(event) =>
										updateTool(index, event.currentTarget.value)
									}
									value={tool.name}
								/>
								<button
									aria-label={`Remove tool ${index + 1}`}
									className="icon-button icon-button--small"
									title={`Remove tool ${index + 1}`}
									type="button"
									onClick={() => {
										removeTool(index);
									}}
								>
									<X aria-hidden="true" size={16} />
									<span className="sr-only">Remove tool</span>
								</button>
							</div>
						))}
						<button
							className="button button--quiet"
							type="button"
							onClick={addTool}
						>
							<Plus aria-hidden="true" size={17} />
							Add tool
						</button>
					</div>
				</div>
				<div className="import-subsection">
					<h3>Nutrition</h3>
					<div className="import-fields-grid">
						{(
							[
								'calories',
								'proteinContent',
								'carbohydrateContent',
								'fatContent',
							] as const
						).map((field) => (
							<RecipeTextField
								key={field}
								label={field.replace('Content', '')}
								onChange={(value) =>
									updateNutritionField(setDraft, field, value)
								}
								value={draft.nutrition?.[field]}
							/>
						))}
					</div>
				</div>
			</section>
		</div>
	);
};

const RecipeImportPreview = ({
	draft,
	onCopyJson,
	setDraft,
}: {
	draft: SchemaOrgRecipe;
	onCopyJson(): void;
	setDraft: Dispatch<SetStateAction<SchemaOrgRecipe | undefined>>;
}) => (
	<section className="recipe-import-preview" aria-label="Parsed recipe preview">
		<header className="recipe-import-preview__header">
			<div>
				<span className="eyebrow">Preview before import</span>
				<h1>{draft.name || 'Untitled recipe'}</h1>
				<p>Edit the structured draft, then confirm the Mealie write.</p>
			</div>
			<button
				className="button button--quiet"
				type="button"
				onClick={onCopyJson}
			>
				<Clipboard aria-hidden="true" size={17} />
				Copy JSON
			</button>
		</header>
		<p className="import-ingredient-parser-note">
			Mealie will parse each final ingredient against your existing foods and
			units when you confirm.
		</p>
		<RecipeDraftEditor draft={draft} setDraft={setDraft} />
	</section>
);

export const RecipeImportPage = ({
	onBack,
	onToggleTheme,
	theme,
}: RecipeImportPageProps) => {
	const [mode, setMode] = useState<RecipeImportMode>('url');
	const [url, setUrl] = useState('');
	const [text, setText] = useState('');
	const [files, setFiles] = useState<File[]>([]);
	const [phase, setPhase] = useState<ImportPhase>('input');
	const [draft, setDraft] = useState<SchemaOrgRecipe>();
	const [reviewNotes, setReviewNotes] = useState<string[]>([]);
	const [parseWarnings, setParseWarnings] = useState<string[]>([]);
	const [acknowledged, setAcknowledged] = useState(false);
	const [error, setError] = useState<string>();
	const [importedSlug, setImportedSlug] = useState<string>();
	const [importedName, setImportedName] = useState<string>();
	const [importedUrl, setImportedUrl] = useState<string>();
	const [ingredientParsing, setIngredientParsing] =
		useState<RecipeImportIngredientParsing>();

	const filePreviews = useMemo(
		() => files.map((file) => ({file, url: URL.createObjectURL(file)})),
		[files],
	);

	useEffect(
		() => () => {
			for (const preview of filePreviews) {
				URL.revokeObjectURL(preview.url);
			}
		},
		[filePreviews],
	);

	const validation = draft ? validateSchemaOrgRecipe(draft) : undefined;
	const visibleWarnings = [
		...reviewNotes,
		...parseWarnings,
		...(validation?.warnings ?? []),
	];
	const canParse =
		(mode === 'url' && url.trim().length > 0) ||
		(mode === 'text' && text.trim().length > 0) ||
		(mode === 'images' && files.length > 0);
	const isBusy = phase === 'parsing' || phase === 'importing';

	const switchMode = (nextMode: RecipeImportMode): void => {
		setMode(nextMode);
		setError(undefined);
	};

	const handleFileChange = (fileList: FileList | undefined): void => {
		if (!fileList) {
			return;
		}

		const nextFiles: File[] = [];

		for (const file of [...fileList]) {
			if (!acceptedImageTypes.has(file.type)) {
				setError('Use PNG, JPEG, or WebP recipe screenshots.');
				continue;
			}

			if (file.size > 10 * 1024 * 1024) {
				setError('Each recipe screenshot must be 10 MB or smaller.');
				continue;
			}

			if (files.length + nextFiles.length < 8) {
				nextFiles.push(file);
			} else {
				setError('Choose no more than 8 recipe screenshots.');
			}
		}

		setFiles((current) => [...current, ...nextFiles].slice(0, 8));
	};

	const parseRecipe = async (): Promise<void> => {
		setPhase('parsing');
		setError(undefined);

		const request: RecipeImportRequest = {
			files,
			mode,
			text: mode === 'text' ? text : undefined,
			url: mode === 'url' ? url : undefined,
		};

		try {
			const response = await api.parseRecipeImport(request);

			setDraft(response.recipe);
			setReviewNotes(response.reviewNotes);
			setParseWarnings(response.warnings);
			setIngredientParsing(undefined);
			setAcknowledged(
				response.reviewNotes.length + response.warnings.length === 0,
			);
			setPhase('preview');
		} catch (parseError) {
			setError(
				parseError instanceof Error
					? parseError.message
					: 'Could not parse the recipe.',
			);
			setPhase('input');
		}
	};

	const confirmImport = async (): Promise<void> => {
		if (!draft || validation?.errors.length) {
			return;
		}

		if (visibleWarnings.length > 0 && !acknowledged) {
			return;
		}

		setPhase('importing');
		setError(undefined);

		try {
			const response = await api.confirmRecipeImport(draft);

			setImportedSlug(response.slug);
			setImportedName(response.recipe.name);
			setImportedUrl(response.mealieUrl);
			setIngredientParsing(response.ingredientParsing);
			setPhase('success');
		} catch (importError) {
			setError(
				importError instanceof Error
					? importError.message
					: 'Could not add the recipe to Mealie.',
			);
			setPhase('preview');
		}
	};

	const copyJson = (): void => {
		if (!draft || !navigator.clipboard?.writeText) {
			setError('Copying is not available in this browser.');
			return;
		}

		void navigator.clipboard
			.writeText(JSON.stringify(draft, null, 2))
			.catch(() => {
				setError('Could not copy the recipe JSON.');
			});
	};

	const startOver = (): void => {
		setUrl('');
		setText('');
		setFiles([]);
		setDraft(undefined);
		setReviewNotes([]);
		setParseWarnings([]);
		setAcknowledged(false);
		setImportedSlug(undefined);
		setImportedName(undefined);
		setImportedUrl(undefined);
		setIngredientParsing(undefined);
		setError(undefined);
		setPhase('input');
	};

	return (
		<main className="app-shell app-shell--import">
			<header className="topbar">
				<div className="brand-mark">
					<Sparkles aria-hidden="true" size={26} />
					<div>
						<strong>Import recipe</strong>
						<span>AI-assisted Mealie import</span>
					</div>
				</div>
				<div className="topbar__actions">
					<button
						className="button button--quiet"
						type="button"
						onClick={onBack}
					>
						<ArrowLeft aria-hidden="true" size={17} />
						Back
					</button>
					<ThemeToggle theme={theme} onToggleTheme={onToggleTheme} />
				</div>
			</header>

			{error ? <div className="banner banner--error">{error}</div> : null}

			{phase === 'success' ? (
				<section className="import-success" aria-label="Recipe imported">
					<CheckCircle2 aria-hidden="true" size={44} />
					<span className="eyebrow">Verified in Mealie</span>
					<h1>{importedName}</h1>
					<p>
						The recipe was added successfully with slug{' '}
						<code>{importedSlug}</code>.
					</p>
					{ingredientParsing ? (
						<p>
							{ingredientParsing.warning ??
								`Mealie parsed ${ingredientParsing.ingredientCount} ingredient${ingredientParsing.ingredientCount === 1 ? '' : 's'} and matched ${ingredientParsing.mappedFoodCount} existing food${ingredientParsing.mappedFoodCount === 1 ? '' : 's'} and ${ingredientParsing.mappedUnitCount} existing unit${ingredientParsing.mappedUnitCount === 1 ? '' : 's'}.${ingredientParsing.llmParsedCount ? ` Used the LLM to clean up ${ingredientParsing.llmParsedCount} unmatched line${ingredientParsing.llmParsedCount === 1 ? '' : 's'}.` : ''}`}
						</p>
					) : null}
					<div className="import-success__actions">
						<a
							className="button button--primary"
							href={importedUrl}
							rel="noreferrer"
							target="_blank"
						>
							<ExternalLink aria-hidden="true" size={17} />
							Open in Mealie
						</a>
						<button className="button" type="button" onClick={startOver}>
							<Plus aria-hidden="true" size={17} />
							Import another
						</button>
						<button className="button" type="button" onClick={onBack}>
							Back to planner
						</button>
					</div>
				</section>
			) : (
				<section className="import-layout">
					<section className="import-source-panel" aria-label="Recipe source">
						<header className="import-source-panel__header">
							<div>
								<span className="eyebrow">One source at a time</span>
								<h1>Bring in a recipe</h1>
								<p>
									Choose a URL, paste unstructured text, or upload screenshots.
								</p>
							</div>
						</header>

						<div
							className="import-mode-tabs"
							role="tablist"
							aria-label="Recipe source type"
						>
							{modes.map((item) => (
								<button
									aria-selected={mode === item.mode}
									className={mode === item.mode ? 'is-active' : ''}
									key={item.mode}
									role="tab"
									type="button"
									onClick={() => {
										switchMode(item.mode);
									}}
								>
									<strong>{item.label}</strong>
									<span>{item.description}</span>
								</button>
							))}
						</div>

						{mode === 'url' ? (
							<label className="import-field import-field--wide">
								<span>Recipe URL</span>
								<input
									autoComplete="url"
									placeholder="https://example.com/recipe"
									type="url"
									value={url}
									onChange={(event) => {
										setUrl(event.currentTarget.value);
									}}
								/>
							</label>
						) : null}

						{mode === 'text' ? (
							<label className="import-field import-field--wide">
								<span>Recipe text</span>
								<textarea
									placeholder="Paste ingredients, directions, timing, and any notes here."
									rows={15}
									value={text}
									onChange={(event) => {
										setText(event.currentTarget.value);
									}}
								/>
							</label>
						) : null}

						{mode === 'images' ? (
							<div className="import-upload">
								<label
									className="button button--upload"
									htmlFor="recipe-images"
								>
									<Upload aria-hidden="true" size={18} />
									Choose screenshots
								</label>
								<input
									accept="image/png,image/jpeg,image/webp"
									className="sr-only"
									id="recipe-images"
									multiple
									type="file"
									onChange={(event) =>
										handleFileChange(event.currentTarget.files ?? undefined)
									}
								/>
								<p>
									PNG, JPEG, and WebP screenshots. Keep pages in reading order.
								</p>
								{filePreviews.length > 0 ? (
									<div className="import-upload__grid">
										{filePreviews.map((preview, index) => (
											<figure
												key={`${preview.file.name}-${preview.file.lastModified}`}
											>
												<img
													alt={`Screenshot ${index + 1}`}
													src={preview.url}
												/>
												<figcaption>
													<span>Page {index + 1}</span>
													<button
														aria-label={`Remove screenshot ${index + 1}`}
														className="icon-button icon-button--small"
														title={`Remove screenshot ${index + 1}`}
														type="button"
														onClick={() => {
															setFiles((current) =>
																current.filter(
																	(_file, fileIndex) => fileIndex !== index,
																),
															);
														}}
													>
														<X aria-hidden="true" size={15} />
														<span className="sr-only">Remove screenshot</span>
													</button>
												</figcaption>
											</figure>
										))}
									</div>
								) : null}
							</div>
						) : null}

						<button
							className="button button--primary import-submit"
							disabled={!canParse || isBusy}
							type="button"
							onClick={() => void parseRecipe()}
						>
							{phase === 'parsing' ? (
								<Loader2 aria-hidden="true" className="spin" size={18} />
							) : (
								<Sparkles aria-hidden="true" size={18} />
							)}
							{phase === 'parsing' ? 'Parsing recipe…' : 'Parse recipe'}
						</button>
					</section>

					{phase === 'preview' || phase === 'importing' ? (
						<section className="import-review-column">
							{visibleWarnings.length > 0 ? (
								<div className="import-review-notes" role="status">
									<strong>Review before importing</strong>
									<ul>
										{visibleWarnings.map((note, index) => (
											<li key={`${index}-${note}`}>{note}</li>
										))}
									</ul>
									<label className="import-acknowledgment">
										<input
											checked={acknowledged}
											type="checkbox"
											onChange={(event) =>
												setAcknowledged(event.currentTarget.checked)
											}
										/>
										I reviewed these notes.
									</label>
								</div>
							) : null}

							{validation?.errors.length ? (
								<div
									className="import-review-notes import-review-notes--error"
									role="alert"
								>
									<strong>Fix before importing</strong>
									<ul>
										{validation.errors.map((message) => (
											<li key={message}>{message}</li>
										))}
									</ul>
								</div>
							) : null}

							{draft ? (
								<RecipeImportPreview
									draft={draft}
									onCopyJson={copyJson}
									setDraft={setDraft}
								/>
							) : null}

							<div className="import-review-actions">
								<button
									className="button"
									disabled={isBusy}
									type="button"
									onClick={() => {
										setPhase('input');
										setError(undefined);
									}}
								>
									<ArrowLeft aria-hidden="true" size={17} />
									Back to source
								</button>
								<button
									className="button button--primary"
									disabled={
										isBusy ||
										Boolean(validation?.errors.length) ||
										(visibleWarnings.length > 0 && !acknowledged)
									}
									type="button"
									onClick={() => void confirmImport()}
								>
									{phase === 'importing' ? (
										<Loader2 aria-hidden="true" className="spin" size={18} />
									) : (
										<CheckCircle2 aria-hidden="true" size={18} />
									)}
									{phase === 'importing'
										? 'Adding to Mealie…'
										: 'Confirm and add to Mealie'}
								</button>
							</div>
						</section>
					) : (
						<section
							className="import-empty-preview"
							aria-label="Recipe preview"
						>
							<FileImage aria-hidden="true" size={34} />
							<strong>Your parsed recipe will appear here</strong>
							<span>
								Review and correct it before anything is written to Mealie.
							</span>
						</section>
					)}
				</section>
			)}
		</main>
	);
};
