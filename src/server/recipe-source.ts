import {lookup} from 'node:dns/promises';
import {createRequire} from 'node:module';
import {isIP} from 'node:net';
import type {RecipeUrlSource} from './recipe-parser';
import {HttpError, isRecord} from './errors';

const maxSourceBytes = 2 * 1024 * 1024;
const maxRedirects = 3;
const sourceTimeoutMs = 15_000;
// The server bundle is CommonJS, so import.meta.url is not available here.
// eslint-disable-next-line unicorn/prefer-module
const moduleRequire = createRequire(__filename);

type LinkedomElement = {
	getAttribute(name: string): string | undefined;
	innerHTML: string;
	remove(): void;
	textContent: string | undefined;
};

type LinkedomDocument = {
	body: LinkedomElement;
	querySelector(selector: string): LinkedomElement | undefined;
	querySelectorAll(selector: string): Iterable<LinkedomElement>;
};

const {parseHTML} = moduleRequire('linkedom') as {
	parseHTML(html: string): {document: LinkedomDocument};
};

const isPrivateIpv4 = (address: string): boolean => {
	const octets = address.split('.').map(Number);
	const [first, second] = octets;

	return (
		first === 10 ||
		first === 127 ||
		(first === 169 && second === 254) ||
		(first === 172 && second >= 16 && second <= 31) ||
		(first === 192 && second === 168) ||
		first === 0
	);
};

const isPrivateIpv6 = (address: string): boolean => {
	const normalized = address.toLowerCase();
	const mappedIpv4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized);

	if (mappedIpv4) {
		return isPrivateIpv4(mappedIpv4[1]);
	}

	return (
		normalized === '::1' ||
		normalized === '::' ||
		normalized.startsWith('fc') ||
		normalized.startsWith('fd') ||
		normalized.startsWith('fe8') ||
		normalized.startsWith('fe9') ||
		normalized.startsWith('fea') ||
		normalized.startsWith('feb')
	);
};

const isPrivateAddress = (address: string): boolean => {
	if (isIP(address) === 4) {
		return isPrivateIpv4(address);
	}

	return isPrivateIpv6(address);
};

const validatePublicUrl = async (value: string): Promise<URL> => {
	let url: URL;

	try {
		url = new URL(value);
	} catch {
		throw new HttpError(400, 'Enter a valid recipe URL.');
	}

	if (
		(url.protocol !== 'http:' && url.protocol !== 'https:') ||
		url.username ||
		url.password ||
		(url.port !== '' && url.port !== '80' && url.port !== '443')
	) {
		throw new HttpError(400, 'Recipe URLs must be public HTTP or HTTPS pages.');
	}

	const hostname = url.hostname.toLowerCase();

	if (
		hostname === 'localhost' ||
		hostname.endsWith('.localhost') ||
		hostname.endsWith('.local') ||
		hostname.endsWith('.internal') ||
		isPrivateAddress(hostname)
	) {
		throw new HttpError(400, 'Private and local recipe URLs are not allowed.');
	}

	try {
		const addresses = await lookup(hostname, {all: true, verbatim: true});

		if (addresses.some(({address}) => isPrivateAddress(address))) {
			throw new HttpError(
				400,
				'Private and local recipe URLs are not allowed.',
			);
		}
	} catch (error) {
		if (error instanceof HttpError) {
			throw error;
		}

		throw new HttpError(400, 'The recipe URL could not be resolved.');
	}

	return url;
};

const readResponseText = async (response: Response): Promise<string> => {
	const contentLength = response.headers.get('content-length');

	if (contentLength && Number(contentLength) > maxSourceBytes) {
		throw new HttpError(413, 'The recipe page is too large to parse.');
	}

	if (!response.body) {
		return '';
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	try {
		while (true) {
			// The stream must be read sequentially to enforce the byte limit.
			// eslint-disable-next-line no-await-in-loop
			const {done, value} = await reader.read();

			if (done) {
				break;
			}

			totalBytes += value.byteLength;

			if (totalBytes > maxSourceBytes) {
				throw new HttpError(413, 'The recipe page is too large to parse.');
			}

			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(totalBytes);
	let offset = 0;

	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return new TextDecoder().decode(bytes);
};

const isRecipeJsonLd = (value: unknown): boolean => {
	if (!isRecord(value)) {
		return false;
	}

	const type = value['@type'];

	return type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'));
};

const collectRecipeJsonLd = (value: unknown, output: string[]): void => {
	if (isRecipeJsonLd(value)) {
		output.push(JSON.stringify(value));
		return;
	}

	if (Array.isArray(value)) {
		for (const item of value) {
			collectRecipeJsonLd(item, output);
		}

		return;
	}

	if (isRecord(value) && Array.isArray(value['@graph'])) {
		collectRecipeJsonLd(value['@graph'], output);
	}
};

const extractSource = (html: string, fetchedUrl: URL): RecipeUrlSource => {
	const {document} = parseHTML(html);
	const jsonLd: string[] = [];

	for (const script of document.querySelectorAll(
		'script[type="application/ld+json"]',
	)) {
		try {
			collectRecipeJsonLd(
				JSON.parse(script.textContent ?? '') as unknown,
				jsonLd,
			);
		} catch {
			// Ignore malformed structured data and let the model use visible text.
		}
	}

	for (const selector of [
		'script',
		'style',
		'noscript',
		'nav',
		'footer',
		'header',
		'aside',
		'form',
	]) {
		for (const element of document.querySelectorAll(selector)) {
			element.remove();
		}
	}

	const visibleText = (document.body?.innerHTML ?? '')
		.replaceAll(/<br\s*\/?>/giu, ' ')
		.replaceAll(/<\/(?:p|h[1-6]|li|div|section|article)>/giu, ' ')
		.replaceAll(/<[^>]+>/gu, ' ')
		.replaceAll(/\s+/gu, ' ')
		.trim()
		.slice(0, 100_000);
	const canonicalHref = document
		.querySelector('link[rel="canonical"]')
		?.getAttribute('href');

	let canonicalUrl = fetchedUrl.toString();

	if (canonicalHref) {
		try {
			const candidate = new URL(canonicalHref, fetchedUrl);

			if (candidate.protocol === 'http:' || candidate.protocol === 'https:') {
				canonicalUrl = candidate.toString();
			}
		} catch {
			// Keep the fetched URL when the page's canonical link is malformed.
		}
	}

	return {
		canonicalUrl,
		jsonLd: [...new Set(jsonLd)],
		visibleText,
	};
};

const fetchPage = async (url: URL): Promise<Response> => {
	try {
		return await fetch(url, {
			headers: {
				Accept:
					'text/html, application/xhtml+xml, application/json;q=0.9, text/plain;q=0.8',
				'User-Agent': 'MealieChefRecipeImporter/1.0',
			},
			redirect: 'manual',
			signal: AbortSignal.timeout(sourceTimeoutMs),
		});
	} catch {
		throw new HttpError(
			504,
			'The recipe page could not be reached before the timeout. Try pasted text or screenshots.',
		);
	}
};

export const fetchRecipeSource = async (
	value: string,
): Promise<RecipeUrlSource> => {
	let currentUrl = await validatePublicUrl(value.trim());
	let response: Response | undefined;

	for (let redirect = 0; redirect <= maxRedirects; redirect++) {
		// Redirects are intentionally fetched one at a time so every target is validated.
		// eslint-disable-next-line no-await-in-loop
		response = await fetchPage(currentUrl);

		if (response.status < 300 || response.status >= 400) {
			break;
		}

		const location = response.headers.get('location');

		if (!location || redirect === maxRedirects) {
			throw new HttpError(502, 'The recipe page redirected too many times.');
		}

		// eslint-disable-next-line no-await-in-loop
		currentUrl = await validatePublicUrl(
			new URL(location, currentUrl).toString(),
		);
	}

	if (!response?.ok) {
		throw new HttpError(
			502,
			`The recipe page could not be fetched (${response?.status ?? 'unknown'}).`,
		);
	}

	const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';

	if (
		contentType &&
		!contentType.includes('text/html') &&
		!contentType.includes('application/xhtml+xml') &&
		!contentType.includes('application/json') &&
		!contentType.includes('text/plain')
	) {
		throw new HttpError(
			415,
			'The recipe URL did not return readable page content.',
		);
	}

	return extractSource(await readResponseText(response), currentUrl);
};
