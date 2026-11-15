// Driver for the markdown-render-speed entry: reads every case from
// /input/cases.json (or $MAKEFUN_INPUT_DIR outside a container), renders each
// one alone with parse() from parse.js, and writes the HTML strings, in the
// cases' order, to /output/html.json (or $MAKEFUN_OUTPUT_DIR).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Array<{ id: string; markdown: string }>;
const html = cases.map((c) => parse(c.markdown));
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
