/** Extract the raw YAML from the Nth diagram or Mermaid fence. */
export function getDiagramBlockRaw(chapterContent: string, index: number): string {
	const re = /```(?:diagram|mermaid)\r?\n([\s\S]*?)```/g;
	let i = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(chapterContent)) !== null) {
		if (i === index) return m[1];
		i++;
	}
	return '';
}

/** Replace one editable visual block while preserving the rest of its Markdown. */
export function spliceVisualBlock(
	fullMarkdown: string,
	kind: 'fence' | 'table' | 'inline' | 'image',
	original: string,
	index: number,
	replacement: string,
	asImage = false
): string {
	if (kind === 'fence') {
		const re = /```(?:diagram|mermaid)\r?\n[\s\S]*?```/g;
		let i = 0, m: RegExpExecArray | null;
		while ((m = re.exec(fullMarkdown)) !== null) {
			if (i === index) {
				const block = asImage ? replacement : `\`\`\`diagram\n${replacement}\n\`\`\``;
				return fullMarkdown.slice(0, m.index) + block + fullMarkdown.slice(m.index + m[0].length);
			}
			i++;
		}
		return asImage ? `${fullMarkdown}\n\n${replacement}` : `${fullMarkdown}\n\n\`\`\`diagram\n${replacement}\n\`\`\``;
	}

	if (original && fullMarkdown.includes(original)) return fullMarkdown.replace(original, replacement);
	return `${fullMarkdown}\n\n${replacement}`;
}

/** Splice a rewritten page back into its original Markdown paragraph range. */
export function splicePage(fullMarkdown: string, startIdx: number, endIdx: number, newMarkdown: string): string {
	if (!fullMarkdown) return fullMarkdown;
	const mdBlocks = fullMarkdown.split(/\n\n+/);
	if (startIdx >= mdBlocks.length) return `${fullMarkdown}\n\n${newMarkdown}`;
	return [...mdBlocks.slice(0, startIdx), newMarkdown.trim(), ...mdBlocks.slice(Math.min(endIdx, mdBlocks.length))].join('\n\n');
}

/** Convert rendered HTML to the plain-text context supplied to the editor. */
export function htmlToPlainText(html: string): string {
	const div = document.createElement('div');
	div.innerHTML = html;
	return div.innerText || div.textContent || '';
}
