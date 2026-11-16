# SwiftMark

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/c/markdown-render-speed-02/)
[![rank](https://make.fun/badge/markdown-render-speed-02/Fajarmalik755/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/c/markdown-render-speed-02/)
[![reward](https://make.fun/badge/markdown-render-speed-02/Fajarmalik755/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/c/markdown-render-speed-02/)

A fast, dependency-free Markdown renderer for the
[markdown-render-speed-02 competition](https://make.fun/c/markdown-render-speed-02/)
on [make.fun](https://make.fun).

`parse.js` exports `parse(markdown)`, which returns exactly the HTML that
marked 18.1.3 renders with its default options (GFM on, breaks off, pedantic
off) — byte for byte on every input — but faster: block and inline parsing
render straight to strings with no token tree, and inline work is deferred
until every link reference definition has been seen.

`main.ts` is the driver the harness runs: it reads every case from
`/input/cases.json`, renders each one alone with `parse`, and writes
`/output/html.json`.

Referral: `25xq9bc4`
