import { test, expect, describe } from "bun:test";
import { renderMarkdown } from "../src/util/md";

describe("renderMarkdown", () => {
  test("escapes HTML", () => {
    const out = renderMarkdown("Hello <script>alert(1)</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  test("renders headings", () => {
    expect(renderMarkdown("# Title")).toContain("<h1>Title</h1>");
    expect(renderMarkdown("## Sub")).toContain("<h2>Sub</h2>");
    expect(renderMarkdown("### Deep")).toContain("<h3>Deep</h3>");
  });

  test("renders unordered lists", () => {
    const out = renderMarkdown("- one\n- two\n- three");
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>one</li>");
    expect(out).toContain("<li>three</li>");
    expect(out).toContain("</ul>");
  });

  test("renders wiki links to /node routes", () => {
    const out = renderMarkdown("See [[auth/login_handler]] for details.");
    expect(out).toContain('href="/node/auth%2Flogin_handler"');
    expect(out).toContain(">auth/login_handler</a>");
  });

  test("renders inline code", () => {
    const out = renderMarkdown("Use `hayven query` to search.");
    expect(out).toContain("<code>hayven query</code>");
  });

  test("renders fenced code blocks without highlighting", () => {
    const out = renderMarkdown("```\nfoo()\nbar()\n```");
    expect(out).toContain("<pre><code>foo()\nbar()</code></pre>");
  });

  test("paragraphs separated by blank lines", () => {
    const out = renderMarkdown("First paragraph.\n\nSecond paragraph.");
    const paragraphs = out.match(/<p>/g) ?? [];
    expect(paragraphs.length).toBe(2);
  });

  test("does not double-encode wiki link names", () => {
    const out = renderMarkdown("[[my_node]]");
    expect(out).toContain(">my_node</a>");
  });

  test("wiki link href encodes the RAW id, not the HTML-escaped one", () => {
    const out = renderMarkdown("[[pkg/foo&bar]]");
    // href must percent-encode the raw `&`, not the escaped `&amp;` text.
    expect(out).toContain('href="/node/pkg%2Ffoo%26bar"');
    expect(out).not.toContain("%26amp%3B");
    // display text stays HTML-escaped
    expect(out).toContain(">pkg/foo&amp;bar</a>");
  });

  test("wiki link href encodes raw quotes", () => {
    const out = renderMarkdown(`[[say"hi"]]`);
    expect(out).toContain(`href="/node/say%22hi%22"`);
    expect(out).not.toContain("%26quot%3B");
  });
});
