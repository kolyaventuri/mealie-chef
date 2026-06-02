import {
	ArrowLeft,
	CalendarDays,
	ChevronLeft,
	ChevronRight,
	ChefHat,
	Copy,
	Loader2,
	RefreshCw,
	Wifi,
	WifiOff,
} from 'lucide-react';
import {QRCodeSVG} from 'qrcode.react';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {
	CookingSession,
	RecipeDetail,
	RecipeSummary,
	ServerSessionMessage,
	SessionMutation,
} from '../shared/types';
import {api, globalWebsocketUrl} from './api';
import {
	IngredientList,
	RecipeSearch,
	StepStack,
	WeekPlanner,
} from './components';

type Route =
	| {
			name: 'planner';
	  }
	| {
			name: 'session';
	  };

const parseRoute = (): Route => {
	if (
		globalThis.location.pathname === '/session' ||
		/^\/sessions\/[^/]+$/.test(globalThis.location.pathname)
	) {
		return {
			name: 'session',
		};
	}

	return {
		name: 'planner',
	};
};

const navigate = (path: string): void => {
	globalThis.history.pushState({}, '', path);
	globalThis.dispatchEvent(new PopStateEvent('popstate'));
};

export const App = () => {
	const [route, setRoute] = useState<Route>(parseRoute);

	useEffect(() => {
		const onPopState = () => {
			setRoute(parseRoute());
		};

		globalThis.addEventListener('popstate', onPopState);

		return () => {
			globalThis.removeEventListener('popstate', onPopState);
		};
	}, []);

	return route.name === 'session' ? (
		<CookingPage />
	) : (
		<PlannerPage
			onOpenSession={() => {
				navigate('/session');
			}}
		/>
	);
};

type PlannerPageProps = {
	onOpenSession(): void;
};

const PlannerPage = ({onOpenSession}: PlannerPageProps) => {
	const [week, setWeek] =
		useState<Awaited<ReturnType<typeof api.getWeekPlanner>>>();
	const [recipes, setRecipes] = useState<RecipeSummary[]>([]);
	const [query, setQuery] = useState('');
	const [isLoading, setIsLoading] = useState(true);
	const [isSearching, setIsSearching] = useState(false);
	const [error, setError] = useState<string>();

	const loadWeek = useCallback(async () => {
		setIsLoading(true);
		setError(undefined);

		try {
			setWeek(await api.getWeekPlanner());
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: 'Could not load planner.',
			);
		} finally {
			setIsLoading(false);
		}
	}, []);

	useEffect(() => {
		void loadWeek();
	}, [loadWeek]);

	const startRecipe = async (recipe: RecipeSummary): Promise<void> => {
		setError(undefined);

		try {
			await api.createSession(recipe.slug);
			onOpenSession();
		} catch (startError) {
			setError(
				startError instanceof Error
					? startError.message
					: 'Could not start session.',
			);
		}
	};

	const searchRecipes = async (): Promise<void> => {
		setIsSearching(true);
		setError(undefined);

		try {
			setRecipes(await api.searchRecipes(query));
		} catch (searchError) {
			setError(
				searchError instanceof Error
					? searchError.message
					: 'Could not search recipes.',
			);
		} finally {
			setIsSearching(false);
		}
	};

	return (
		<main className="app-shell">
			<header className="topbar">
				<div className="brand-mark">
					<ChefHat aria-hidden="true" size={26} />
					<div>
						<strong>Mealie Sync</strong>
						<span>Kitchen display</span>
					</div>
				</div>
				<button
					className="icon-button"
					title="Refresh"
					type="button"
					onClick={loadWeek}
				>
					<RefreshCw aria-hidden="true" size={20} />
					<span className="sr-only">Refresh</span>
				</button>
			</header>

			{error ? <div className="banner banner--error">{error}</div> : null}

			<section className="planner-layout">
				<div className="planner-main">
					<div className="section-heading">
						<CalendarDays aria-hidden="true" size={22} />
						<h1>Week</h1>
					</div>
					{isLoading ? (
						<div className="loading-row">
							<Loader2 aria-hidden="true" className="spin" size={22} />
							Loading
						</div>
					) : week ? (
						<WeekPlanner
							days={week.days}
							onStartRecipe={(recipe) => void startRecipe(recipe)}
						/>
					) : null}
				</div>
				<RecipeSearch
					isLoading={isSearching}
					onQueryChange={setQuery}
					onSearch={() => void searchRecipes()}
					onStartRecipe={(recipe) => void startRecipe(recipe)}
					query={query}
					recipes={recipes}
				/>
			</section>
		</main>
	);
};

const CookingPage = () => {
	const [session, setSession] = useState<CookingSession>();
	const [recipe, setRecipe] = useState<RecipeDetail>();
	const [presence, setPresence] = useState(0);
	const [isConnected, setIsConnected] = useState(false);
	const [error, setError] = useState<string>();
	const socketRef = useRef<WebSocket | undefined>(null);
	const copyText = useMemo(() => `${globalThis.location.origin}/session`, []);

	useEffect(() => {
		let isMounted = true;

		const loadSession = async (): Promise<void> => {
			try {
				const nextSession = await api.getGlobalSession();

				if (isMounted) {
					if (nextSession) {
						setSession(nextSession);
						setError(undefined);
					} else {
						setError('No recipe is active yet. Start one from the planner.');
					}
				}
			} catch (loadError) {
				if (isMounted) {
					setError(
						loadError instanceof Error
							? loadError.message
							: 'Could not load session.',
					);
				}
			}
		};

		void loadSession();

		return () => {
			isMounted = false;
		};
	}, []);

	useEffect(() => {
		let isMounted = true;
		const recipeSlug = session?.recipeSlug;

		const loadRecipe = async (): Promise<void> => {
			if (!recipeSlug) {
				return;
			}

			try {
				const nextRecipe = await api.getRecipe(recipeSlug);

				if (isMounted) {
					setRecipe(nextRecipe);
				}
			} catch (loadError) {
				if (isMounted) {
					setError(
						loadError instanceof Error
							? loadError.message
							: 'Could not load recipe.',
					);
				}
			}
		};

		void loadRecipe();

		return () => {
			isMounted = false;
		};
	}, [session?.recipeSlug]);

	useEffect(() => {
		const socket = new WebSocket(globalWebsocketUrl());
		socketRef.current = socket;

		socket.addEventListener('open', () => {
			setIsConnected(true);
		});
		socket.addEventListener('close', () => {
			setIsConnected(false);
		});
		socket.addEventListener('message', (event) => {
			const message = JSON.parse(event.data as string) as ServerSessionMessage;

			if (message.type === 'snapshot') {
				setSession(message.session);
				setError(undefined);
			}

			if (message.type === 'patch') {
				setSession(message.session);
				setError(undefined);
			}

			if (message.type === 'presence') {
				setPresence(message.count);
			}

			if (message.type === 'error') {
				setError(message.message);
			}
		});

		return () => {
			socket.close();
		};
	}, []);

	const sendPatch = async (patch: SessionMutation): Promise<void> => {
		const socket = socketRef.current;

		if (socket?.readyState === WebSocket.OPEN) {
			socket.send(
				JSON.stringify({
					patch,
					type: 'patch',
				}),
			);
			return;
		}

		setSession(await api.patchGlobalSession(patch));
	};

	if (!session || !recipe) {
		return (
			<main className="app-shell">
				<div className="loading-row">
					<Loader2 aria-hidden="true" className="spin" size={22} />
					Loading
				</div>
				{error ? <div className="banner banner--error">{error}</div> : null}
			</main>
		);
	}

	const activeStepIndex = Math.min(
		session.activeStepIndex,
		Math.max(recipe.steps.length - 1, 0),
	);
	const canGoBack = activeStepIndex > 0;
	const canGoForward = activeStepIndex < recipe.steps.length - 1;

	return (
		<main className="app-shell app-shell--cooking">
			<header className="topbar topbar--cooking">
				<button
					className="icon-button"
					title="Back"
					type="button"
					onClick={() => {
						navigate('/');
					}}
				>
					<ArrowLeft aria-hidden="true" size={21} />
					<span className="sr-only">Back</span>
				</button>
				<div className="recipe-title">
					<strong>{recipe.name}</strong>
					<span>Shared session</span>
				</div>
				<div className={`connection-pill ${isConnected ? 'is-online' : ''}`}>
					{isConnected ? (
						<Wifi aria-hidden="true" size={17} />
					) : (
						<WifiOff aria-hidden="true" size={17} />
					)}
					{presence || 1}
				</div>
			</header>

			{error ? <div className="banner banner--error">{error}</div> : null}

			<section className="cook-layout">
				<aside className="session-panel">
					<div className="qr-box">
						<QRCodeSVG value={copyText} size={148} />
					</div>
					<button
						className="button"
						type="button"
						onClick={() => {
							void navigator.clipboard.writeText(copyText);
						}}
					>
						<Copy aria-hidden="true" size={18} />
						Copy link
					</button>
					<div className="step-rail" aria-label="Step selector">
						{recipe.steps.map((step) => (
							<button
								className={step.index === activeStepIndex ? 'is-active' : ''}
								key={step.index}
								type="button"
								onClick={() =>
									void sendPatch({
										activeStepIndex: step.index,
										type: 'set-active-step',
									})
								}
							>
								{step.index + 1}
							</button>
						))}
					</div>
				</aside>

				<section className="steps-region">
					<div className="step-controls">
						<button
							className="button"
							disabled={!canGoBack}
							type="button"
							onClick={() =>
								void sendPatch({
									activeStepIndex: activeStepIndex - 1,
									type: 'set-active-step',
								})
							}
						>
							<ChevronLeft aria-hidden="true" size={20} />
							Prev
						</button>
						<strong>
							{activeStepIndex + 1} / {recipe.steps.length || 1}
						</strong>
						<button
							className="button button--primary"
							disabled={!canGoForward}
							type="button"
							onClick={() =>
								void sendPatch({
									activeStepIndex: activeStepIndex + 1,
									type: 'set-active-step',
								})
							}
						>
							Next
							<ChevronRight aria-hidden="true" size={20} />
						</button>
					</div>
					<StepStack activeIndex={activeStepIndex} steps={recipe.steps} />
				</section>

				<aside className="ingredients-region">
					<h2>Ingredients</h2>
					<IngredientList
						activeStepIndex={activeStepIndex}
						ingredients={recipe.ingredients}
						states={session.ingredientStates}
						onCheckedChange={(ingredientKey, checked) =>
							void sendPatch({
								checked,
								ingredientKey,
								type: 'set-ingredient-checked',
							})
						}
					/>
				</aside>
			</section>
		</main>
	);
};
