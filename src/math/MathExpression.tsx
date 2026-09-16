import { createElement, type ReactNode } from "react";

import {
  toMathML,
  type MathMLElement,
  type MathNode,
} from "../../shared/math-expression";
import { describeJudgeEntry } from "../../shared/scoring";

/**
 * Renders an expression tree as MathML through React's element API. Every leaf
 * is a text node React escapes itself, and every tag comes from the closed
 * `MathMLElement` union, so no judge-supplied text can become markup. React 19
 * creates `<math>` and its children in the MathML namespace.
 */
function element(node: MathMLElement, key?: number): ReactNode {
  const children = node.children.map((child, index) =>
    typeof child === "string" ? child : element(child, index),
  );
  return createElement(
    node.tag,
    { ...(node.attributes ?? {}), key },
    ...children,
  );
}

export function MathTree({
  node,
  className,
}: {
  node: MathNode;
  className?: string;
}) {
  const tree = toMathML(node);
  return createElement(
    tree.tag,
    {
      ...(tree.attributes ?? {}),
      ...(className ? { className } : {}),
    },
    ...tree.children.map((child, index) =>
      typeof child === "string" ? child : element(child, index),
    ),
  );
}

/**
 * A judge's entry as it should be read: a plain number or single constant
 * exactly as typed, anything richer typeset. The original text is always the
 * source of truth; nothing here decides what the score counts as.
 */
export function JudgeEntry({
  raw,
  className,
}: {
  raw: string;
  className?: string;
}) {
  const entry = describeJudgeEntry(raw);
  if (entry.kind === "plain") {
    return <span className={className}>{entry.text}</span>;
  }
  return (
    <MathTree
      node={entry.node}
      className={`${className ?? ""} math-entry`.trim()}
    />
  );
}
