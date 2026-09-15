import { useMemo, useState, type ReactNode } from "react";

import readmeSource from "../../README.md?raw";
import {
  parseMarkdown,
  tableOfContents,
  type Block,
  type Inline,
} from "./markdown";

/**
 * The operator guide, rendered from the repository's own README so there is one
 * canonical source of documentation rather than a copy that drifts.
 *
 * The document becomes React elements, never HTML: nothing in it can execute,
 * and nothing it does can reach the show. Opening the guide is a pure view
 * change — no command is sent and no state is touched.
 */
export function HelpPanel() {
  const blocks = useMemo(() => parseMarkdown(readmeSource), []);
  const contents = useMemo(() => tableOfContents(blocks), [blocks]);
  const [query, setQuery] = useState("");

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? blocks.filter((block) => blockText(block).toLowerCase().includes(needle))
    : blocks;

  return (
    <section className="help" aria-labelledby="help-title">
      <div className="region-title">
        <p>HELP</p>
        <h2 id="help-title">Operator guide</h2>
        <span>
          The full manual, exactly as shipped with this version. Nothing here
          changes the show.
        </span>
      </div>

      <div className="help__tools">
        <label className="help__search">
          <span className="sr-only">Search the guide</span>
          <input
            type="search"
            placeholder="Search the guide…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {needle.length > 0 && (
          <span className="help__count">
            {visible.length} matching section{visible.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <div className="help__body">
        {needle.length === 0 && contents.length > 0 && (
          <nav className="help__contents" aria-label="Guide contents">
            {contents.map((entry) => (
              <a key={entry.id} href={`#${entry.id}`}>
                {entry.title}
              </a>
            ))}
          </nav>
        )}
        <article className="help__document">
          {visible.length === 0 ? (
            <p className="help__empty">
              Nothing in the guide matches “{query.trim()}”.
            </p>
          ) : (
            visible.map((block, index) => (
              <BlockView key={index} block={block} />
            ))
          )}
        </article>
      </div>
    </section>
  );
}

function blockText(block: Block): string {
  switch (block.kind) {
    case "heading":
    case "paragraph":
    case "quote":
      return block.content.map((node) => node.text).join(" ");
    case "list":
      return block.items
        .flatMap((item) => item.map((node) => node.text))
        .join(" ");
    case "code":
      return block.text;
    case "table":
      return [...block.headers, ...block.rows.flat()]
        .flatMap((cell) => cell.map((node) => node.text))
        .join(" ");
    case "rule":
      return "";
  }
}

function InlineView({ nodes }: { nodes: readonly Inline[] }): ReactNode {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case "strong":
        return <strong key={index}>{node.text}</strong>;
      case "emphasis":
        return <em key={index}>{node.text}</em>;
      case "code":
        return <code key={index}>{node.text}</code>;
      case "link":
        return (
          <a
            key={index}
            href={node.href}
            {...(node.href.startsWith("#")
              ? {}
              : { target: "_blank", rel: "noreferrer noopener" })}
          >
            {node.text}
          </a>
        );
      case "text":
        return <span key={index}>{node.text}</span>;
    }
  });
}

function BlockView({ block }: { block: Block }): ReactNode {
  switch (block.kind) {
    case "heading": {
      const content = <InlineView nodes={block.content} />;
      if (block.level === 1) return <h1 id={block.id}>{content}</h1>;
      if (block.level === 2) return <h2 id={block.id}>{content}</h2>;
      if (block.level === 3) return <h3 id={block.id}>{content}</h3>;
      return <h4 id={block.id}>{content}</h4>;
    }
    case "paragraph":
      return (
        <p>
          <InlineView nodes={block.content} />
        </p>
      );
    case "quote":
      return (
        <blockquote>
          <InlineView nodes={block.content} />
        </blockquote>
      );
    case "list":
      return block.ordered ? (
        <ol>
          {block.items.map((item, index) => (
            <li key={index}>
              <InlineView nodes={item} />
            </li>
          ))}
        </ol>
      ) : (
        <ul>
          {block.items.map((item, index) => (
            <li key={index}>
              <InlineView nodes={item} />
            </li>
          ))}
        </ul>
      );
    case "code":
      return (
        <pre>
          <code>{block.text}</code>
        </pre>
      );
    case "table":
      return (
        <div className="help__table">
          <table>
            <thead>
              <tr>
                {block.headers.map((cell, index) => (
                  <th key={index}>
                    <InlineView nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>
                      <InlineView nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "rule":
      return <hr />;
  }
}
