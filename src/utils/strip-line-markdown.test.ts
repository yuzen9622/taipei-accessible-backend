import { describe, it, expect } from "vitest";
import { stripLineMarkdown } from "./strip-line-markdown";

describe("stripLineMarkdown", () => {
  it("returns empty / plain text unchanged", () => {
    expect(stripLineMarkdown("")).toBe("");
    expect(stripLineMarkdown("今天天氣不錯，記得帶傘。")).toBe(
      "今天天氣不錯，記得帶傘。",
    );
  });

  it("strips bold and italic emphasis", () => {
    expect(stripLineMarkdown("**重點**")).toBe("重點");
    expect(stripLineMarkdown("*斜體*")).toBe("斜體");
    expect(stripLineMarkdown("__粗體__")).toBe("粗體");
    expect(stripLineMarkdown("這是**很重要**的事")).toBe("這是很重要的事");
  });

  it("leaves single underscores in identifiers and URLs intact", () => {
    expect(stripLineMarkdown("foo_bar_baz")).toBe("foo_bar_baz");
    expect(stripLineMarkdown("https://example.com/a_b_c")).toBe(
      "https://example.com/a_b_c",
    );
  });

  it("removes heading markers but keeps the text", () => {
    expect(stripLineMarkdown("# 標題")).toBe("標題");
    expect(stripLineMarkdown("### 小標")).toBe("小標");
  });

  it("converts unordered bullets to a plain marker", () => {
    expect(stripLineMarkdown("- 項目一")).toBe("・ 項目一");
    expect(stripLineMarkdown("* 項目二")).toBe("・ 項目二");
    expect(stripLineMarkdown("+ 項目三")).toBe("・ 項目三");
  });

  it("leaves ordered lists as plain text", () => {
    expect(stripLineMarkdown("1. 第一步")).toBe("1. 第一步");
  });

  it("flattens links to label + url", () => {
    expect(stripLineMarkdown("[Google](https://g.com)")).toBe(
      "Google https://g.com",
    );
  });

  it("strips inline code and fenced code blocks", () => {
    expect(stripLineMarkdown("用 `npm test` 執行")).toBe("用 npm test 執行");
    const fenced = stripLineMarkdown("```js\nconst x = 1;\n```");
    expect(fenced).not.toContain("```");
    expect(fenced).toContain("const x = 1;");
  });

  it("flattens a markdown table and drops the separator row", () => {
    const table = ["| 地點 | 時間 |", "| --- | --- |", "| 台北 | 08:00 |"].join(
      "\n",
    );
    const out = stripLineMarkdown(table);
    expect(out).not.toContain("|");
    expect(out).not.toContain("---");
    expect(out).toBe("地點　時間\n台北　08:00");
  });

  it("collapses excess blank lines and trailing spaces", () => {
    expect(stripLineMarkdown("行一   \n\n\n\n行二")).toBe("行一\n\n行二");
  });

  it("is idempotent", () => {
    const input = "**台北**目前 `多雲`\n- 溫度 28 度\n[地圖](https://m.com)";
    const once = stripLineMarkdown(input);
    expect(stripLineMarkdown(once)).toBe(once);
  });
});
