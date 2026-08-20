import {Moon, Sun} from 'lucide-react';

export type Theme = 'dark' | 'light';

type ThemeToggleProps = {
	onToggleTheme(): void;
	theme: Theme;
};

export const ThemeToggle = ({onToggleTheme, theme}: ThemeToggleProps) => {
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
