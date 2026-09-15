/**
 * A deliberately small Markdown reader for one job: rendering this repository's
 * README inside the console as the operator guide.
 *
 * It parses text into a typed block/inline tree. It never produces HTML, so the
 * renderer can only ever create React elements — there is no `innerHTML` path
 * and therefore no way for document content to execute anything. Link targets
 * are filtered to http(s) and in-page anchors for the same reason.
 *
 * It supports exactly what the README uses: headings, paragraphs, lists,
 * fenced code, tables, block quotes, rules, and inline emphasis, code and
 * links. Anything it does not recognise is rendered as plain text rather than
 * being silently dropped.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "emphasis"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4; id: string; content: Inline[] }
  | { kind: "paragraph"; content: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "code"; text: string }
  | { kind: "quote"; content: Inline[] }
  | { kind: "table"; headers: Inline[][]; rows: Inline[][][] }
  | { kind: "rule" };

/** Only in-document anchors and ordinary web links survive. */
function safeHref(href: string): string | null {
  const value = href.trim();
  if (value.startsWith("#")) return value;
  return /^https?:\/\//iu.test(value) ? value : null;
}

export function headingId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .trim()
    .replace(/\s+/gu, "-");
}

const INLINE_PATTERN =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))|(\*[^*]+\*)|(_[^_]+_)/u;

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let rest = source;
  while (rest.length > 0) {
    const match = INLINE_PATTERN.exec(rest);
    if (!match || match.index === undefined) {
      out.push({ kind: "text", text: rest });
      break;
    }
    if (match.index > 0)
      out.push({ kind: "text", text: rest.slice(0, match.index) });
    const token = match[0];
    if (token.startsWith("`")) {
      out.push({ kind: "code", text: token.slice(1, -1) });
    } else if (token.startsWith("**")) {
      out.push({ kind: "strong", text: token.slice(2, -2) });
    } else if (token.startsWith("[")) {
      const split = token.indexOf("](");
      const text = token.slice(1, split);
      const href = safeHref(token.slice(split + 2, -1));
      out.push(href ? { kind: "link", text, href } : { kind: "text", text });
    } else {
      out.push({ kind: "emphasis", text: token.slice(1, -1) });
    }
    rest = rest.slice(match.index + token.length);
  }
  return out.filter((node) => node.kind !== "text" || node.text.length > 0);
}

function tableCells(line: string): string[] {
  return line
    .replace(/^\||\|$/gu, "")
    .split("|")
    .map((cell) => cell.trim());
}

const isDivider = (line: string): boolean =>
  /^\|?[\s:-]+\|[\s|:-]*$/u.test(line) && line.includes("-");

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/gu, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      index += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").startsWith("```")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }

    if (/^(-{3,}|_{3,}|\*{3,})$/u.test(trimmed)) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/u.exec(trimmed);
    if (heading) {
      const level = heading[1]!.length as 1 | 2 | 3 | 4;
      const text = heading[2]!;
      blocks.push({
        kind: "heading",
        level,
        id: headingId(text.replace(/[*`]/gu, "")),
        content: parseInline(text),
      });
      index += 1;
      continue;
    }

    if (trimmed.startsWith(">")) {
      const body: string[] = [];
      while (
        index < lines.length &&
        (lines[index] ?? "").trim().startsWith(">")
      ) {
        body.push((lines[index] ?? "").trim().replace(/^>\s?/u, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", content: parseInline(body.join(" ")) });
      continue;
    }

    if (trimmed.startsWith("|") && isDivider(lines[index + 1]?.trim() ?? "")) {
      const headers = tableCells(trimmed).map(parseInline);
      index += 2;
      const rows: Inline[][][] = [];
      while (
        index < lines.length &&
        (lines[index] ?? "").trim().startsWith("|")
      ) {
        rows.push(tableCells((lines[index] ?? "").trim()).map(parseInline));
        index += 1;
      }
      blocks.push({ kind: "table", headers, rows });
      continue;
    }

    const bullet = /^([-*+]|\d+\.)\s+(.*)$/u.exec(trimmed);
    if (bullet) {
      const ordered = /\d/u.test(bullet[1]!);
      const items: Inline[][] = [];
      let current: string | null = null;
      while (index < lines.length) {
        const candidate = lines[index] ?? "";
        const candidateTrimmed = candidate.trim();
        const next = /^([-*+]|\d+\.)\s+(.*)$/u.exec(candidateTrimmed);
        if (next && /\d/u.test(next[1]!) === ordered) {
          if (current !== null) items.push(parseInline(current));
          current = next[2]!;
          index += 1;
          continue;
        }
        // A wrapped continuation line belongs to the item above it.
        if (
          current !== null &&
          candidateTrimmed.length > 0 &&
          /^\s+/u.test(candidate)
        ) {
          current = `${current} ${candidateTrimmed}`;
          index += 1;
          continue;
        }
        break;
      }
      if (current !== null) items.push(parseInline(current));
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const candidate = (lines[index] ?? "").trim();
      if (
        candidate.length === 0 ||
        candidate.startsWith("#") ||
        candidate.startsWith("```") ||
        candidate.startsWith(">") ||
        candidate.startsWith("|") ||
        /^([-*+]|\d+\.)\s+/u.test(candidate) ||
        /^(-{3,}|_{3,}|\*{3,})$/u.test(candidate)
      )
        break;
      paragraph.push(candidate);
      index += 1;
    }
    blocks.push({
      kind: "paragraph",
      content: parseInline(paragraph.join(" ")),
    });
  }

  return blocks;
}

/** The `##` headings, for the guide's own contents rail. */
export function tableOfContents(
  blocks: readonly Block[],
): { id: string; title: string }[] {
  return blocks
    .filter((block) => block.kind === "heading" && block.level === 2)
    .map((block) => {
      const heading = block as Extract<Block, { kind: "heading" }>;
      return {
        id: heading.id,
        title: heading.content.map((node) => node.text).join(""),
      };
    });
}
