import {lookup} from 'node:dns/promises';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {HttpError} from './errors';
import {fetchRecipeSource} from './recipe-source';

vi.mock('node:dns/promises', () => ({
	lookup: vi.fn(async () => [{address: '93.184.216.34', family: 4}]),
}));

const lookupMock = vi.mocked(lookup);

describe('recipe URL source fetching', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		lookupMock.mockImplementation(
			async () => [{address: '93.184.216.34', family: 4}] as never,
		);
	});

	it('extracts recipe JSON-LD and cleaned main text', async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					`<html><head><link rel="canonical" href="/recipes/lemon-pasta"><script type="application/ld+json">{"@type":"Recipe","name":"Lemon Pasta"}</script></head><body><nav>Navigation</nav><main><h1>Lemon Pasta</h1><p>Boil pasta and add lemon.</p></main><footer>Footer</footer></body></html>`,
					{headers: {'content-type': 'text/html'}},
				),
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			fetchRecipeSource('https://example.com/recipes/lemon-pasta'),
		).resolves.toEqual(
			expect.objectContaining({
				canonicalUrl: 'https://example.com/recipes/lemon-pasta',
				jsonLd: [JSON.stringify({'@type': 'Recipe', name: 'Lemon Pasta'})],
				visibleText: 'Lemon Pasta Boil pasta and add lemon.',
			}),
		);
		expect(fetchMock).toHaveBeenCalledWith(
			new URL('https://example.com/recipes/lemon-pasta'),
			expect.objectContaining({redirect: 'manual'}),
		);
	});

	it('uses the cleaned body text when recipe JSON-LD is absent or incomplete', async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					'<html><body><main><h1>Soup</h1><p>Heat the stock.</p></main><div><p>Add beans and simmer.</p></div></body></html>',
					{headers: {'content-type': 'text/html'}},
				),
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			fetchRecipeSource('https://example.com/soup'),
		).resolves.toEqual(
			expect.objectContaining({
				jsonLd: [],
				visibleText: 'Soup Heat the stock. Add beans and simmer.',
			}),
		);
	});

	it('validates every redirect before following it', async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(null, {
					headers: {location: 'http://127.0.0.1/private'},
					status: 302,
				}),
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			fetchRecipeSource('https://example.com/redirect'),
		).rejects.toMatchObject({statusCode: 400});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('rejects private DNS targets and oversized pages', async () => {
		lookupMock.mockImplementationOnce(
			async () => [{address: '192.168.1.20', family: 4}] as never,
		);

		await expect(
			fetchRecipeSource('https://example.com/private'),
		).rejects.toMatchObject({statusCode: 400});

		lookupMock.mockImplementation(
			async () => [{address: '93.184.216.34', family: 4}] as never,
		);
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response('small', {
						headers: {
							'content-length': String(2 * 1024 * 1024 + 1),
							'content-type': 'text/html',
						},
					}),
			),
		);

		await expect(
			fetchRecipeSource('https://example.com/large'),
		).rejects.toMatchObject({statusCode: 413});
	});

	it('rejects unsupported URL protocols', async () => {
		const error = await fetchRecipeSource('ftp://example.com/recipe').catch(
			(error_: unknown) => error_,
		);

		expect(error).toBeInstanceOf(HttpError);
		expect(error).toMatchObject({statusCode: 400});
	});
});
