import type { Language } from "./text.ts";

/** One line of release notes, shown as plain text: a heading, a list item or a paragraph. */
export interface NoteBlock { readonly kind: "heading" | "item" | "text"; readonly text: string }

/** The DOM nodes the reader needs; DOMParser documents provide them, and tests build small trees. */
export interface NoteNode { readonly nodeName: string; readonly textContent: string | null; readonly childNodes: ArrayLike<NoteNode> }

const MAX_BLOCKS = 200, MAX_TEXT = 2000;
const LANGUAGE_HEADINGS: Readonly<Record<string, Language>> = { "français": "fr", "francais": "fr", "english": "en" };

/**
 * Plain-text blocks from a release's rendered notes: everything before the first horizontal rule (the download
 * instructions follow it), and only the reader's language when the notes have "Français" and "English" headings.
 * Links, images and markup are dropped; nothing from the notes is ever inserted as HTML.
 */
export function noteBlocks(body: NoteNode, language: Language): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  const add = (kind: NoteBlock["kind"], value: string | null): void => {
    const text = (value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
    if (text !== "" && blocks.length < MAX_BLOCKS) blocks.push({ kind, text });
  };
  // Returns false at the rule, which ends the notes.
  const walk = (node: NoteNode): boolean => {
    for (const child of Array.from(node.childNodes)) {
      const name = child.nodeName.toUpperCase();
      if (name === "HR") return false;
      if (/^H[1-6]$/.test(name)) add("heading", child.textContent);
      else if (name === "LI") add("item", child.textContent);
      else if (name === "P" || name === "#TEXT") add("text", child.textContent);
      else if (name !== "SCRIPT" && name !== "STYLE" && name !== "#COMMENT" && !walk(child)) return false;
    }
    return true;
  };
  walk(body);
  const marks = blocks.flatMap((block, index) => block.kind === "heading" && LANGUAGE_HEADINGS[block.text.toLowerCase()] !== undefined ? [{ index, language: LANGUAGE_HEADINGS[block.text.toLowerCase()]! }] : []);
  const chosen = marks.find(mark => mark.language === language);
  if (chosen === undefined) return blocks;
  const next = marks.find(mark => mark.index > chosen.index);
  return blocks.slice(chosen.index + 1, next?.index ?? blocks.length);
}

/** Parses GitHub's rendered HTML in an inert document (no scripts run, nothing loads) and reads its blocks. */
export function parseNotes(html: string, language: Language): NoteBlock[] {
  return noteBlocks(new DOMParser().parseFromString(html, "text/html").body, language);
}
