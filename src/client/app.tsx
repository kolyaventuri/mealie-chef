import {
	ArrowLeft,
	CalendarDays,
	ChevronLeft,
	ChevronRight,
	ChefHat,
	Copy,
	CookingPot,
	Loader2,
	Moon,
	QrCode,
	RefreshCw,
	Sun,
	Wifi,
	WifiOff,
	X,
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

type Theme = 'dark' | 'light';

const themeStorageKey = 'mealie-ipad-sync-theme';

const readStoredTheme = (): Theme => {
	try {
		const storedTheme = globalThis.localStorage.getItem(themeStorageKey);

		if (storedTheme === 'dark' || storedTheme === 'light') {
			return storedTheme;
		}
	} catch {
		// Local storage can be unavailable in restricted browser contexts.
	}

	if (globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches) {
		return 'dark';
	}

	return 'light';
};

export const App = () => {
	const [route, setRoute] = useState<Route>(parseRoute);
	const [theme, setTheme] = useState<Theme>(readStoredTheme);

	useEffect(() => {
		const onPopState = () => {
			setRoute(parseRoute());
		};

		globalThis.addEventListener('popstate', onPopState);

		return () => {
			globalThis.removeEventListener('popstate', onPopState);
		};
	}, []);

	useEffect(() => {
		document.documentElement.dataset.theme = theme;
		document.documentElement.style.colorScheme = theme;

		try {
			globalThis.localStorage.setItem(themeStorageKey, theme);
		} catch {
			// Local storage can be unavailable in restricted browser contexts.
		}
	}, [theme]);

	const toggleTheme = () => {
		setTheme((currentTheme) => (currentTheme === 'dark' ? 'light' : 'dark'));
	};

	return route.name === 'session' ? (
		<CookingPage theme={theme} onToggleTheme={toggleTheme} />
	) : (
		<PlannerPage
			theme={theme}
			onOpenSession={() => {
				navigate('/session');
			}}
			onToggleTheme={toggleTheme}
		/>
	);
};

type PlannerPageProps = {
	onOpenSession(): void;
	onToggleTheme(): void;
	theme: Theme;
};

const PlannerPage = ({
	onOpenSession,
	onToggleTheme,
	theme,
}: PlannerPageProps) => {
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
				<div className="topbar__actions">
					<ThemeToggle theme={theme} onToggleTheme={onToggleTheme} />
					<button
						className="icon-button"
						title="Refresh"
						type="button"
						onClick={loadWeek}
					>
						<RefreshCw aria-hidden="true" size={20} />
						<span className="sr-only">Refresh</span>
					</button>
				</div>
			</header>

			{error ? <div className="banner banner--error">{error}</div> : null}

			<section className="planner-layout">
				<div className="planner-main">
					<div className="section-heading">
						<span className="section-heading__icon">
							<CalendarDays aria-hidden="true" size={22} />
						</span>
						<div>
							<h1>Meal Plan</h1>
							<p>This week</p>
						</div>
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

type ThemeToggleProps = {
	onToggleTheme(): void;
	theme: Theme;
};

const ThemeToggle = ({onToggleTheme, theme}: ThemeToggleProps) => {
	const nextTheme = theme === 'dark' ? 'light' : 'dark';

	return (
		<button
			aria-label={`Switch to ${nextTheme} mode`}
			className="icon-button theme-toggle"
			title={`Switch to ${nextTheme} mode`}
			type="button"
			onClick={onToggleTheme}
		>
			{theme === 'dark' ? (
				<Sun aria-hidden="true" size={19} />
			) : (
				<Moon aria-hidden="true" size={19} />
			)}
			<span className="sr-only">Switch to {nextTheme} mode</span>
		</button>
	);
};

const WakeLockToggle = () => {
	const [isRequested, setIsRequested] = useState(false);
	const [isActive, setIsActive] = useState(false);
	const [statusMessage, setStatusMessage] = useState<string>();
	const isRequestedRef = useRef(false);
	const wakeLockRef = useRef<WakeLockSentinel | undefined>(undefined);

	useEffect(() => {
		isRequestedRef.current = isRequested;
	}, [isRequested]);

	const releaseWakeLock = useCallback(async (): Promise<void> => {
		const wakeLock = wakeLockRef.current;
		wakeLockRef.current = undefined;
		setIsActive(false);

		if (wakeLock && !wakeLock.released) {
			try {
				await wakeLock.release();
			} catch {
				// Browsers can release wake locks automatically before cleanup runs.
			}
		}
	}, []);

	const requestWakeLock = useCallback(async (): Promise<void> => {
		if (!('wakeLock' in navigator)) {
			wakeLockRef.current = undefined;
			setIsActive(false);
			setIsRequested(false);
			setStatusMessage('Wake lock is not available in this browser.');
			return;
		}

		if (document.visibilityState !== 'visible') {
			setIsActive(false);
			return;
		}

		try {
			const wakeLock = await navigator.wakeLock.request('screen');

			if (!isRequestedRef.current) {
				try {
					await wakeLock.release();
				} catch {
					// The lock may already be released by the browser.
				}

				return;
			}

			wakeLockRef.current = wakeLock;
			setIsActive(true);
			setStatusMessage(undefined);
			wakeLock.addEventListener(
				'release',
				() => {
					if (wakeLockRef.current === wakeLock) {
						wakeLockRef.current = undefined;
						setIsActive(false);
					}
				},
				{once: true},
			);
		} catch (error) {
			wakeLockRef.current = undefined;
			setIsActive(false);
			setIsRequested(false);
			setStatusMessage(
				error instanceof Error && error.message
					? error.message
					: 'Wake lock could not be enabled.',
			);
		}
	}, []);

	useEffect(() => {
		if (!isRequested) {
			void releaseWakeLock();
			return;
		}

		void requestWakeLock();

		const onVisibilityChange = () => {
			if (document.visibilityState === 'visible' && !wakeLockRef.current) {
				void requestWakeLock();
			}
		};

		document.addEventListener('visibilitychange', onVisibilityChange);

		return () => {
			document.removeEventListener('visibilitychange', onVisibilityChange);
			void releaseWakeLock();
		};
	}, [isRequested, releaseWakeLock, requestWakeLock]);

	const onToggle = useCallback(() => {
		setStatusMessage(undefined);
		setIsRequested((currentValue) => !currentValue);
	}, []);
	const modeLabel = isRequested ? 'Disable Cook mode' : 'Enable Cook mode';
	const statusLabel = statusMessage
		? 'Blocked'
		: isActive
			? 'On'
			: isRequested
				? 'Starting'
				: 'Off';

	return (
		<button
			aria-label={
				statusMessage ? `Cook mode unavailable: ${statusMessage}` : modeLabel
			}
			aria-pressed={isRequested}
			className={`cook-mode-toggle ${isRequested ? 'is-requested' : ''} ${isActive ? 'is-active' : ''} ${statusMessage ? 'has-error' : ''}`}
			title={statusMessage ?? modeLabel}
			type="button"
			onClick={onToggle}
		>
			<CookingPot aria-hidden="true" size={19} />
			<span className="cook-mode-toggle__label">Cook mode</span>
			<span className="cook-mode-toggle__status" aria-hidden="true">
				{statusLabel}
			</span>
		</button>
	);
};

type CookingPageProps = {
	onToggleTheme(): void;
	theme: Theme;
};

const CookingPage = ({onToggleTheme, theme}: CookingPageProps) => {
	const [session, setSession] = useState<CookingSession>();
	const [recipe, setRecipe] = useState<RecipeDetail>();
	const [presence, setPresence] = useState(0);
	const [isConnected, setIsConnected] = useState(false);
	const [hasAutoHiddenSetup, setHasAutoHiddenSetup] = useState(false);
	const [isSetupPanelHidden, setIsSetupPanelHidden] = useState(false);
	const [collapsedStepIndexes, setCollapsedStepIndexes] = useState(
		() => new Set<number>(),
	);
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
		setCollapsedStepIndexes(new Set());
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

	const connectedDeviceCount = presence || 1;

	useEffect(() => {
		if (connectedDeviceCount > 1 && !hasAutoHiddenSetup) {
			setIsSetupPanelHidden(true);
			setHasAutoHiddenSetup(true);
		}
	}, [connectedDeviceCount, hasAutoHiddenSetup]);

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

	const setStepCollapsed = useCallback(
		(stepIndex: number, isCollapsed: boolean) => {
			setCollapsedStepIndexes((currentIndexes) => {
				const nextIndexes = new Set(currentIndexes);

				if (isCollapsed) {
					nextIndexes.add(stepIndex);
				} else {
					nextIndexes.delete(stepIndex);
				}

				return nextIndexes;
			});
		},
		[],
	);

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
					<span>Cooking now</span>
				</div>
				<div className="topbar__actions">
					<WakeLockToggle />
					{isSetupPanelHidden ? (
						<button
							aria-label="Show setup panel"
							className="icon-button setup-toggle"
							title="Show setup panel"
							type="button"
							onClick={() => {
								setIsSetupPanelHidden(false);
							}}
						>
							<QrCode aria-hidden="true" size={19} />
							<span className="sr-only">Show setup panel</span>
						</button>
					) : null}
					<ThemeToggle theme={theme} onToggleTheme={onToggleTheme} />
					<div className={`connection-pill ${isConnected ? 'is-online' : ''}`}>
						{isConnected ? (
							<Wifi aria-hidden="true" size={17} />
						) : (
							<WifiOff aria-hidden="true" size={17} />
						)}
						{connectedDeviceCount}
					</div>
				</div>
			</header>

			{error ? <div className="banner banner--error">{error}</div> : null}

			<section
				className={`cook-layout ${isSetupPanelHidden ? 'is-setup-hidden' : ''}`}
			>
				{isSetupPanelHidden ? null : (
					<aside className="session-panel">
						<div className="session-panel__header">
							<span>Setup</span>
							<button
								aria-label="Hide setup panel"
								className="icon-button icon-button--small"
								title="Hide setup panel"
								type="button"
								onClick={() => {
									setIsSetupPanelHidden(true);
								}}
							>
								<X aria-hidden="true" size={17} />
								<span className="sr-only">Hide setup panel</span>
							</button>
						</div>
						<div className="share-block">
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
						</div>
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
				)}

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
					<StepStack
						activeIndex={activeStepIndex}
						collapsedStepIndexes={collapsedStepIndexes}
						steps={recipe.steps}
						onCollapsedStepChange={setStepCollapsed}
					/>
				</section>

				<aside className="ingredients-region">
					<header className="ingredients-region__header">
						<h2>Ingredients</h2>
						<span>{recipe.ingredients.length}</span>
					</header>
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
