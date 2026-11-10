import { isDeepStrictEqual } from "node:util";

import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type Edit,
  type FormattingOptions,
  type ParseError,
} from "jsonc-parser";

/**
 * Pure text transforms for an OpenCode `opencode.json[c]` file. Edits go through
 * jsonc-parser so comments, trailing commas and unrelated formatting survive.
 */

export const OPENCODE_SERVER_NAME = "transversals";

export type OpenCodeEdit =
  | { status: "unchanged" }
  | { status: "changed"; text: string; location: string };

export class OpenCodeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeConfigError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRoot(text: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new OpenCodeConfigError(
      `invalid JSONC (${printParseErrorCode(first.error)} at offset ${first.offset})`,
    );
  }
  if (!isPlainObject(value)) throw new OpenCodeConfigError("top level is not an object");
  return value;
}

/** Matches the file's own indentation and line endings for inserted text. */
function formattingFor(text: string): FormattingOptions {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = /^([ \t]+)\S/m.exec(text)?.[1];
  if (indent?.startsWith("\t")) return { insertSpaces: false, tabSize: 1, eol };
  const width = indent?.length ?? 2;
  return { insertSpaces: true, tabSize: width >= 2 && width <= 8 ? width : 2, eol };
}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

/**
 * jsonc-parser removes `"key": value,` plus the whitespace up to the next sibling,
 * which pulls that sibling onto the previous line. When the removed text spans
 * whole lines, widen/shrink the edit to those lines so the layout stays tidy.
 */
function tidyRemoval(text: string, edit: Edit): Edit {
  if (edit.content !== "") return edit;
  const start = edit.offset;
  const end = edit.offset + edit.length;
  const startLine = lineStart(text, start);
  const endLine = lineStart(text, end);
  if (
    endLine > start &&
    text.slice(startLine, start).trim() === "" &&
    text.slice(endLine, end).trim() === ""
  ) {
    return { offset: startLine, length: endLine - startLine, content: "" };
  }
  return edit;
}

/** Where the transversals entry belongs: `mcp.servers` when that object exists, else `mcp`. */
function entryPath(root: Record<string, unknown>): string[] {
  const mcp = root.mcp;
  return isPlainObject(mcp) && isPlainObject(mcp.servers)
    ? ["mcp", "servers", OPENCODE_SERVER_NAME]
    : ["mcp", OPENCODE_SERVER_NAME];
}

/** Adds or replaces the transversals server entry. Throws OpenCodeConfigError on bad input. */
export function upsertOpenCodeServer(text: string, entry: unknown): OpenCodeEdit {
  const root = parseRoot(text);
  const path = entryPath(root);
  const existing = path.reduce<unknown>(
    (node, key) => (isPlainObject(node) ? node[key] : undefined),
    root,
  );
  if (isDeepStrictEqual(existing, entry)) return { status: "unchanged" };

  const edits = modify(text, path, entry, {
    formattingOptions: formattingFor(text),
    // Insert as the first member so the edit never touches sibling lines.
    getInsertionIndex: () => 0,
  });
  const updated = applyEdits(text, edits);
  parseRoot(updated);
  return { status: "changed", text: updated, location: path.join(".") };
}

/** Removes the transversals entry from both `mcp.servers` and `mcp`, if present. */
export function removeOpenCodeServer(text: string): OpenCodeEdit {
  const root = parseRoot(text);
  const mcp = root.mcp;
  const paths: string[][] = [];
  if (isPlainObject(mcp)) {
    if (isPlainObject(mcp.servers) && OPENCODE_SERVER_NAME in mcp.servers) {
      paths.push(["mcp", "servers", OPENCODE_SERVER_NAME]);
    }
    if (OPENCODE_SERVER_NAME in mcp) paths.push(["mcp", OPENCODE_SERVER_NAME]);
  }
  if (paths.length === 0) return { status: "unchanged" };

  let updated = text;
  for (const path of paths) {
    const edits = modify(updated, path, undefined, {}).map((edit) => tidyRemoval(updated, edit));
    updated = applyEdits(updated, edits);
  }
  parseRoot(updated);
  return { status: "changed", text: updated, location: paths.map((path) => path.join(".")).join(", ") };
}
