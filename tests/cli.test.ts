import { describe, expect, test } from 'vitest';
import { readFileSync, rmSync, writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Readable } from 'stream';
import { Defuddle } from '../src/node';
import { parseSource, createProgram } from '../src/cli';
import { parseDocument } from './helpers';

const fixturePath = join(__dirname, 'fixtures', 'general--appendix-heading.html');
const fixtureHtml = readFileSync(fixturePath, 'utf-8');

function createMockStdin(html: string, isTTY = false): NodeJS.ReadStream {
	const stdin = Readable.from([html], { encoding: 'utf8' }) as NodeJS.ReadStream;
	(stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY = isTTY;
	return stdin;
}

async function getExpectedContent(html: string): Promise<string> {
	const doc = parseDocument(html);
	const result = await Defuddle(doc);
	return result.content;
}

function stripHtmlAndNormalizeWhitespace(html: string): string {
	return html
		.replace(/<[^>]*>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

describe('CLI parseSource', () => {
	test('reads HTML from stdin when no source is provided', async () => {
		const expected = await getExpectedContent(fixtureHtml);

		const result = await parseSource(undefined, {}, createMockStdin(fixtureHtml));

		expect(stripHtmlAndNormalizeWhitespace(result.output)).toEqual(stripHtmlAndNormalizeWhitespace(expected));
	});

	test('reads HTML from stdin when source is "-"', async () => {
		const result = await parseSource('-', { json: true }, createMockStdin(fixtureHtml));
		const parsed = JSON.parse(result.output);

		expect(parsed.title).toBe('Article with Appendix');
		expect(parsed.content).toContain('Appendix I');
	});

	test('continues to read local HTML files', async () => {
		const tempDir = mkdtempSync(join(tmpdir(), 'defuddle-cli-'));
		const filePath = join(tempDir, 'page.html');
		try {
			writeFileSync(filePath, fixtureHtml, 'utf-8');

			const expected = await getExpectedContent(fixtureHtml);
			const result = await parseSource(filePath, {});

			expect(stripHtmlAndNormalizeWhitespace(result.output)).toEqual(stripHtmlAndNormalizeWhitespace(expected));
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('throws a helpful error when no source is provided and stdin is a TTY', async () => {
		const stdin = createMockStdin('', true);

		await expect(parseSource(undefined, {}, stdin)).rejects.toThrow(
			'No input source provided. Pass a file path or URL, or pipe HTML to stdin.'
		);
	});

	test('prepends YAML frontmatter when --frontmatter is set', async () => {
		const body = await getExpectedContent(fixtureHtml);

		const result = await parseSource(undefined, { frontmatter: true }, createMockStdin(fixtureHtml));

		expect(result.output.startsWith('---\n')).toBe(true);
		expect(result.output).toContain('title: "Article with Appendix"');
		// frontmatter block closes with --- followed by a blank line, then the body
		expect(result.output).toContain('---\n\n' + body);
		// stdin input has no URL, so no source: line is emitted
		expect(result.output).not.toContain('source:');
	});

	test('omits frontmatter by default', async () => {
		const result = await parseSource(undefined, {}, createMockStdin(fixtureHtml));
		expect(result.output.startsWith('---')).toBe(false);
	});

	test('registers the --frontmatter flag with a -f alias', () => {
		const parseCommand = createProgram().commands.find((c) => c.name() === 'parse');
		const option = parseCommand?.options.find((o) => o.long === '--frontmatter');

		expect(option).toBeDefined();
		expect(option?.short).toBe('-f');
		expect(option?.attributeName()).toBe('frontmatter');
	});

	describe('--url for saved pages', () => {
		// Site extractors are selected by URL, which a saved page on disk lacks.
		const savedChatHtml = `<!DOCTYPE html><html><head><title>Example chat - Claude</title></head><body>
			<aside><p>Recent chats: first placeholder chat, second placeholder chat, third placeholder chat, fourth placeholder chat.</p></aside>
			<main>
				<div data-testid="user-message"><p>Placeholder user question</p></div>
				<div class="font-claude-response"><div class="standard-markdown"><p>Placeholder assistant answer</p></div></div>
			</main>
		</body></html>`;

		test('uses the site extractor for stdin input when --url is set', async () => {
			const result = await parseSource(undefined, { url: 'https://claude.ai/chat/example', markdown: true }, createMockStdin(savedChatHtml));

			// Author labels are only emitted by the conversation extractor.
			expect(result.output).toContain('**You**');
			expect(result.output).toContain('**Claude**');
			expect(result.output).toContain('Placeholder user question');
			expect(result.output).toContain('Placeholder assistant answer');
			expect(result.output).not.toContain('Recent chats');
		});

		test('uses --url as the frontmatter source', async () => {
			const result = await parseSource(undefined, { url: 'https://claude.ai/chat/example', frontmatter: true }, createMockStdin(savedChatHtml));

			expect(result.output).toContain('source: "https://claude.ai/chat/example"');
		});

		test('rejects a non-http(s) --url', async () => {
			await expect(parseSource(undefined, { url: 'claude.ai/chat/example' }, createMockStdin(savedChatHtml))).rejects.toThrow('--url');
		});

		test('rejects --url when the source is already a URL', async () => {
			await expect(parseSource('https://example.com/', { url: 'https://claude.ai/chat/example' })).rejects.toThrow('--url');
		});

		test('registers the --url flag', () => {
			const parseCommand = createProgram().commands.find((c) => c.name() === 'parse');
			const option = parseCommand?.options.find((o) => o.long === '--url');

			expect(option).toBeDefined();
			expect(option?.attributeName()).toBe('url');
		});
	});

	test('registers the --user-agent flag with a -u alias', () => {
		const parseCommand = createProgram().commands.find((c) => c.name() === 'parse');
		const option = parseCommand?.options.find((o) => o.long === '--user-agent');

		expect(option).toBeDefined();
		expect(option?.short).toBe('-u');
		// commander camelCases --user-agent → options.userAgent, which parseSource reads.
		expect(option?.attributeName()).toBe('userAgent');
	});
});
