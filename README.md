# Make Markdown rendering faster

[![make.fun](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun/competitions/markdown-render-speed-02)

A fast, dependency-free Markdown renderer. `parse(markdown)` returns exactly
the HTML that marked 18.1.3 renders with its default options (GFM on), but
renders it with far less CPU: a single-pass, allocation-light scanner instead
of marked's regex-heavy tokenizer.

## Run it

```sh
node main.ts
```

`main.ts` reads every case from `/input/cases.json` (or
`$MAKEFUN_INPUT_DIR/cases.json` outside a container), renders each one alone
with `parse()` from `parse.js`, and writes the HTML strings, in order, to
`/output/html.json` (or `$MAKEFUN_OUTPUT_DIR/html.json`).

To grade it locally with the competition kit:

```sh
node cli/makefun.mjs grade-local --kit . --bot <repository> --driver process
```
