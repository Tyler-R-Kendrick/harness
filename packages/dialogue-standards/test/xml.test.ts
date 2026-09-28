import { describe, expect, it } from "vitest";
import { DocumentError, elements, parseXml, resolvePath, textOf } from "../src/xml.ts";

describe("XML documents", () => {
  it("XM1.1 attributes are keyed by local name, but xml: and xmlns attributes keep their whole name", () => {
    expect(parseXml(`<a xmlns="urn:d" xmlns:v="urn:v" xml:lang="en" v:x="1" y="2"/>`, "a.xml").attrs).toEqual({ xmlns: "urn:d", "xmlns:v": "urn:v", "xml:lang": "en", x: "1", y: "2" });
  });

  it("XM1.2 an element's children are its elements and its text and CDATA as strings; comments and processing instructions are dropped", () => {
    expect(parseXml(`<a>x<![CDATA[<y>]]><!--c--><?pi d?><b k="v">z</b></a>`, "a.xml")).toEqual({
      name: "a",
      attrs: {},
      children: ["x", "<y>", { name: "b", attrs: { k: "v" }, children: ["z"] }],
    });
  });

  it("XM1.3 an error the parser recovers from still refuses the document, naming the file and the problem", () => {
    expect(() => parseXml("<a>&foo;</a>", "bad.xml")).toThrow(DocumentError);
    expect(() => parseXml("<a>&foo;</a>", "bad.xml")).toThrow(new DocumentError("bad.xml: entity not found:&foo;"));
  });

  it("XM1.4 a warning does not refuse the document", () => {
    expect(parseXml("<a x=1 b/>", "a.xml").attrs).toEqual({ x: "1", b: "b" });
  });

  it("XM1.5 a fatal error refuses the document, naming the file and the problem", () => {
    expect(() => parseXml("", "empty.xml")).toThrow(new DocumentError("empty.xml: missing root element"));
    expect(() => parseXml("<a><b></a>", "a.xml")).toThrow(DocumentError);
  });

  it("XM1.6 text is an element's descendants' text with each whitespace run one space; elements filter by name", () => {
    const a = parseXml("<a>one\n\t<b>two</b>  three<c/><b/></a>", "a.xml");
    expect(textOf(a)).toBe("one two three");
    expect(textOf("x\n\ny")).toBe("x y");
    expect(elements(a).map((e) => e.name)).toEqual(["b", "c", "b"]);
    expect(elements(a, "b")).toHaveLength(2);
  });

  it("XM1.7 a reference resolves from the referring file's folder, or from the top with a leading slash", () => {
    const cases = [
      ["app/main.vxml", "g/sizes.grxml", "app/g/sizes.grxml"],
      ["app/main.vxml", "./g.grxml", "app/g.grxml"],
      ["app/main.vxml", "../g.grxml", "g.grxml"],
      ["app/main.vxml", "g//x.grxml", "app/g/x.grxml"],
      ["app/main.vxml", "/g/x.grxml", "g/x.grxml"],
      ["main.vxml", "x.grxml", "x.grxml"],
    ] as const;
    expect(cases.map(([file, ref]) => [file, ref, resolvePath(file, ref)])).toEqual(cases);
  });
});
