const CHUNK_LIMIT = 3400;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function preBlock(code: string, lang = "text"): string {
  return `<pre><code class="language-${lang}">${escapeHtml(code)}</code></pre>`;
}

/** Markdown ringan -> HTML Telegram. Escape dulu, baru tag. */
export function markdownToHtml(input: string): string {
  const blocks: string[] = [];
  let text = input.replace(/\r\n/g, "\n");

  text = text.replace(
    /```([A-Za-z0-9_+-]*)\n?([\s\S]*?)```/g,
    (_match, lang: string, body: string) => {
      const index = blocks.push(preBlock(body.replace(/\n$/, ""), lang || "text")) - 1;
      return `\u0000CB${index}\u0000`;
    }
  );

  text = escapeHtml(text);

  text = text
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|\s)__([^_\n]+)__/g, "$1<b>$2</b>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/^\s*(\d+)\.\s+/gm, "$1. ");

  return text.replace(/\u0000CB(\d+)\u0000/g, (_match, index: string) => blocks[Number(index)] ?? "");
}

/** Potong HTML jadi beberapa pesan tanpa merusak blok <pre> dan tanpa membuang isi. */
export function chunkHtml(html: string, limit = CHUNK_LIMIT): string[] {
  const chunks: string[] = [];
  let buffer = "";
  let inPre = false;

  const flush = (): void => {
    if (buffer.trim() === "") {
      buffer = "";
      return;
    }
    chunks.push(inPre ? `${buffer}</code></pre>` : buffer);
    buffer = inPre ? '<pre><code class="language-text">' : "";
  };

  const append = (piece: string): void => {
    if (buffer.length + piece.length + 1 > limit) flush();
    buffer += (buffer ? "\n" : "") + piece;

    const opens = (piece.match(/<pre><code/g) ?? []).length;
    const closes = (piece.match(/<\/code><\/pre>/g) ?? []).length;
    if (opens > closes) inPre = true;
    else if (closes > opens) inPre = false;
  };

  const splitLongLine = (line: string, size: number): string[] => {
    const parts: string[] = [];
    let index = 0;
    while (index < line.length) {
      let end = Math.min(index + size, line.length);
      if (end < line.length) {
        const lastOpen = line.lastIndexOf("<", end);
        const lastClose = line.lastIndexOf(">", end);
        if (lastOpen > lastClose && end - lastOpen < 200) end = lastOpen;
        const lastSpace = line.lastIndexOf(" ", end);
        if (lastSpace > index + size / 2) end = lastSpace;
      }
      if (end <= index) end = Math.min(index + size, line.length);
      parts.push(line.slice(index, end));
      index = end;
    }
    return parts;
  };

  for (const rawLine of html.split("\n")) {
    if (rawLine.length <= limit) {
      append(rawLine);
      continue;
    }
    for (const piece of splitLongLine(rawLine, limit - 100)) append(piece);
  }

  flush();
  return chunks.length > 0 ? chunks : ["(kosong)"];
}

export function renderMarkdown(input: string): string[] {
  return chunkHtml(markdownToHtml(input));
}
