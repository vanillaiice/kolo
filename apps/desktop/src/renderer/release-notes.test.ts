import assert from "node:assert/strict";
import { it } from "node:test";
import { noteBlocks, type NoteNode } from "./release-notes.ts";

/** A tiny element tree shaped like a DOMParser body: [name, ...children], strings are text nodes. */
type Tree = string | [string, ...Tree[]];
function node(tree: Tree): NoteNode {
  if (typeof tree === "string") return { nodeName: "#text", textContent: tree, childNodes: [] };
  const [name, ...children] = tree, childNodes = children.map(node);
  return { nodeName: name, childNodes, get textContent() { return childNodes.map(child => child.textContent).join(""); } };
}

const github: Tree = ["BODY",
  ["H3", "Français"], ["UL", "\n", ["LI", "Nouvelle ", ["A", "mise à jour"]], ["LI", "Correctif"]],
  ["H3", "English"], ["UL", ["LI", "New ", ["STRONG", "update"]], ["LI", "Fix"]], ["P", "Thanks."],
  ["HR"], ["P", "Windows: download the setup installer."]];

it("reads the reader's language and stops at the rule before the download instructions", () => {
  assert.deepEqual(noteBlocks(node(github), "fr"), [{ kind: "item", text: "Nouvelle mise à jour" }, { kind: "item", text: "Correctif" }]);
  assert.deepEqual(noteBlocks(node(github), "en"), [{ kind: "item", text: "New update" }, { kind: "item", text: "Fix" }, { kind: "text", text: "Thanks." }]);
});

it("shows everything when the notes are not split by language, and drops scripts, styles and comments", () => {
  const plain: Tree = ["BODY", ["H2", "Fixes"], ["DIV", ["P", "  Receipts   print\nagain "], ["SCRIPT", "alert(1)"], ["STYLE", "p{}"], ["#comment", "x"]], ["OL", ["LI", "One"]], "tail"];
  assert.deepEqual(noteBlocks(node(plain), "fr"), [{ kind: "heading", text: "Fixes" }, { kind: "text", text: "Receipts print again" }, { kind: "item", text: "One" }, { kind: "text", text: "tail" }]);
  assert.deepEqual(noteBlocks(node(["BODY", ["H3", "English"], ["P", "Only English"]]), "fr"), [{ kind: "heading", text: "English" }, { kind: "text", text: "Only English" }]);
  assert.deepEqual(noteBlocks(node(["BODY", ["HR"], ["P", "after"]]), "en"), []);
  assert.deepEqual(noteBlocks(node(["BODY"]), "en"), []);
});

it("bounds what it reads", () => {
  const huge: Tree = ["BODY", ["UL", ...Array.from({ length: 500 }, (_value, index): Tree => ["LI", `item ${index} ${"x".repeat(5000)}`])]];
  const blocks = noteBlocks(node(huge), "en");
  assert.equal(blocks.length, 200);
  assert.ok(blocks.every(block => block.text.length <= 2000));
});
