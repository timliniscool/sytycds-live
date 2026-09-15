/// <reference types="vite/client" />

/**
 * Markdown imported as text for the in-app operator guide. It is parsed into a
 * typed tree and rendered as React elements; it is never treated as HTML.
 */
declare module "*.md?raw" {
  const content: string;
  export default content;
}
