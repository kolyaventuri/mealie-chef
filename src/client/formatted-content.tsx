import DOMPurify from 'dompurify';
import {marked} from 'marked';
import {useMemo} from 'react';

type FormattedContentProps = {
	className?: string;
	markdown: string;
};

export const renderSafeMarkdown = (markdown: string): string => {
	const html = marked.parse(markdown, {
		async: false,
		gfm: true,
	});

	return DOMPurify.sanitize(html, {
		ADD_ATTR: ['target'],
	});
};

export const FormattedContent = ({
	className,
	markdown,
}: FormattedContentProps) => {
	const html = useMemo(() => renderSafeMarkdown(markdown), [markdown]);

	return <div className={className} dangerouslySetInnerHTML={{__html: html}} />;
};
