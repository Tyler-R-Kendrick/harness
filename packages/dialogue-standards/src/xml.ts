import { DOMParser } from "@xmldom/xmldom";
import type { Node as DomNode } from "@xmldom/xmldom";

/** An XML element as plain data: its local name, attributes and children (text as strings). */
export interface XNode {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly (XNode | string)[];
}

export class DocumentError extends Error {}

const ELEMENT = 1;
const TEXT = 3;
const CDATA = 4;

function convert(node: DomNode): XNode {
  const element = node as unknown as { localName: string; attributes: ArrayLike<{ name: string; localName: string; value: string }>; childNodes: ArrayLike<DomNode> };
  const attrs: Record<string, string> = {};
  for (const a of Array.from(element.attributes)) attrs[a.name.startsWith("xml:") || a.name.startsWith("xmlns") ? a.name : a.localName] = a.value;
  const children: (XNode | string)[] = [];
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === ELEMENT) children.push(convert(child));
    else if (child.nodeType === TEXT || child.nodeType === CDATA) children.push((child as unknown as { data: string }).data);
  }
  return { name: element.localName, attrs, children };
}

/** Parses XML into its root element; malformed XML throws a DocumentError naming the file. */
export function parseXml(text: string, file: string): XNode {
  const problems: string[] = [];
  let doc;
  try {
    doc = new DOMParser({ onError: (level, message) => void (level === "warning" ? undefined : problems.push(message)) }).parseFromString(text, "text/xml");
  } catch (e) {
    throw new DocumentError(`${file}: ${(e as Error).message}`);
  }
  const root = doc.documentElement;
  if (problems.length > 0 || !root) throw new DocumentError(`${file}: ${problems[0] ?? "no root element"}`);
  return convert(root);
}

export const elements = (node: XNode, name?: string): XNode[] => node.children.filter((c): c is XNode => typeof c !== "string" && (name === undefined || c.name === name));

/** An element's text, its descendants' included, with whitespace runs collapsed. */
export const textOf = (node: XNode | string): string => (typeof node === "string" ? node : node.children.map(textOf).join("")).replace(/\s+/g, " ");

/**
 * A reference from `file` to another file, named as the imported files are: relative to
 * `file`'s folder (`./` and `../` resolved), or from the top with a leading `/`.
 */
export function resolvePath(file: string, ref: string): string {
  const parts = ref.startsWith("/") ? [] : file.split("/").slice(0, -1);
  for (const part of ref.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}
