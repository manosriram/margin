// Run: node test/md.test.mjs — checks math extraction/escaping in md() (KaTeX stubbed)
import { readFileSync } from "fs";
const src = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const body = src.slice(src.indexOf("const MATH ="), src.indexOf("\n}\n", src.indexOf("function md(")) + 2);
globalThis.window = globalThis;
globalThis.katex = { renderToString: (t, o) => `[${o.displayMode ? "D" : "I"}:${t}]` };
const md = new Function(body + "; return md;")();
const cases = [
  ["scale by $1/\\sqrt{d_k}$ here", "scale by [I:1/\\sqrt{d_k}] here"],
  ["$$\\sum_i x_i$$", "[D:\\sum_i x_i]"],
  ["\\(a<b\\) and \\[x^2\\]", "[I:a<b] and [D:x^2]"],
  ["costs $5 and $10 total", "costs $5 and $10 total"],
  ["**bold** <b> `c`", "<b>bold</b> &lt;b&gt; <code>c</code>"],
  ["open $x^2 still streaming", "open $x^2 still streaming"],
  ["$a*b*c$ and **x**", "[I:a*b*c] and <b>x</b>"],
];
let ok = true;
for (const [i, want] of cases) { const got = md(i); if (got !== want) { ok = false; console.log("FAIL", JSON.stringify(i), "→", got); } }
console.log(ok ? "all md cases pass" : "failures");
if (!ok) process.exit(1);
