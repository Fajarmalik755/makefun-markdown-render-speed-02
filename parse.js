// SwiftMark — a fast, dependency-free Markdown renderer.
//
// parse(markdown) returns exactly the HTML that marked 18.1.3 renders with
// its default options (GFM on, breaks off, pedantic off). The grammar and the
// rendering rules below follow marked 18.1.3's behaviour (MIT, MarkedJS);
// this file is an independent implementation written for speed: block and
// inline parsing render straight to strings, with no token tree, and inline
// work is deferred until every link reference definition has been seen.
//
// Referral: 25xq9bc4

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function edit(src, flags) {
  let t = typeof src === 'string' ? src : src.source;
  const api = {
    replace(s, r) {
      let o = typeof r === 'string' ? r : r.source;
      o = o.replace(T.caret, '$1');
      t = t.replace(s, o);
      return api;
    },
    getRegex() { return new RegExp(t, flags || ''); },
  };
  return api;
}

function memo(fn) {
  const cache = [];
  return (n) => {
    const i = Math.max(0, Math.min(3, n - 1));
    return cache[i] || (cache[i] = fn(i));
  };
}

// ---------------------------------------------------------------------------
// Shared helper patterns (values mirror the CommonMark/GFM edge cases)
// ---------------------------------------------------------------------------

const K = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const T = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  caret: /(^|[^\[])\^/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (a) => new RegExp(`^( {0,3}${a})((?:[\t ][^\n]*)?(?:\n|$))`),
  nextBulletRegex: memo((a) => new RegExp(`^ {0,${a}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\n|$))`)),
  hrRegex: memo((a) => new RegExp(`^ {0,${a}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\n+|$)`)),
  fencesBeginRegex: memo((a) => new RegExp(`^ {0,${a}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: memo((a) => new RegExp(`^ {0,${a}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: memo((a) => new RegExp(`^ {0,${a}}(?:</?(?:${K})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: memo((a) => new RegExp(`^ {0,${a}}>`)),
};

// ---------------------------------------------------------------------------
// Escaping / entities / URLs
// ---------------------------------------------------------------------------

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escOne = (ch) => ESC_MAP[ch];

function escEncode(html) {
  if (T.escapeTest.test(html)) return html.replace(T.escapeReplace, escOne);
  return html;
}

function escNoEncode(html) {
  if (T.escapeTestNoEncode.test(html)) return html.replace(T.escapeReplaceNoEncode, escOne);
  return html;
}

// Decode numeric character references only; a bare & that does not start a
// valid entity becomes &amp;. Mirrors marked's unescape for text runs.
function unescapeNumeric(html) {
  if (!T.numericCharacterReference.test(html)) return html;
  return html.replace(T.numericCharacterReferenceOrAmpersand, (all, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (code === 0 || code > 1114111 || (code >= 55296 && code <= 57343)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(T.percentDecode, '%');
  } catch (e) {
    return null;
  }
  return href;
}

// ---------------------------------------------------------------------------
// Small string helpers
// ---------------------------------------------------------------------------

// Normalize a link label: trim, collapse inner whitespace, fold case the
// way marked does (lower -> upper -> lower, which matters for e.g. ß -> ss).
function normalizeLabel(a) {
  return a.trim().replace(T.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// findClosingBracket: index of the first unmatched closer, -2 when an opener
// is left unclosed, -1 when balanced / absent.
function findClosingBracket(a, e) {
  if (a.indexOf(e[0]) === -1 && a.indexOf(e[1]) === -1) return -1;
  let level = 0;
  for (let n = 0; n < a.length; n++) {
    if (a[n] === '\\') { n++; continue; }
    if (a[n] === e[0]) level++;
    else if (a[n] === e[1]) {
      level--;
      if (level < 0) return n;
    }
  }
  return level > 0 ? -2 : -1;
}

// rtrim: with `inv` unset, strip trailing chars equal to `ch`; with `inv`
// set, strip trailing chars different from `ch`.
function rtrim(a, ch, inv) {
  const n = a.length;
  if (n === 0) return '';
  let s = 0;
  for (; s < n;) {
    const r = a.charAt(n - s - 1);
    if (r === ch && !inv) s++;
    else if (r !== ch && inv) s++;
    else break;
  }
  return a.slice(0, n - s);
}

// Strip trailing blank lines, keeping at most the shape marked keeps.
function stripTrailingBlanks(a) {
  const lines = a.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && T.blankLine.test(lines[t]);) t--;
  return lines.length - t <= 2 ? a : lines.slice(0, t + 1).join('\n');
}

// Split one table row into cells, honouring \| and edge pipes.
function splitCells(a, count) {
  const t = a.replace(T.findPipe, (r, o, i) => {
    let escaped = false, p = o;
    for (; --p >= 0 && i[p] === '\\';) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const n = t.split(T.splitPipe);
  if (!n[0].trim()) n.shift();
  if (n.length > 0 && !n.at(-1)?.trim()) n.pop();
  if (count) {
    if (n.length > count) n.splice(count);
    else for (; n.length < count;) n.push('');
  }
  for (let s = 0; s < n.length; s++) n[s] = n[s].trim().replace(T.slashPipe, '|');
  return n;
}

// Expand tabs in `a` as if `a` started at column `col`.
function expandTabs(a, col) {
  let out = '', t = col || 0;
  for (const ch of a) {
    if (ch === '\t') {
      const r = 4 - (t % 4);
      out += ' '.repeat(r);
      t += r;
    } else {
      out += ch;
      t++;
    }
  }
  return out;
}

// Compensate an indented fence: dedent code lines by the fence's indent.
function fenceDedent(raw, text) {
  const m = raw.match(T.indentCodeCompensation);
  if (m === null) return text;
  const indent = m[1];
  return text.split('\n').map((line) => {
    const o = line.match(T.beginningSpace);
    if (o === null) return line;
    return line.slice(Math.min(o[0].length, indent.length));
  }).join('\n');
}

// Does a link label contain a raw HTML tag that runs past the label's end?
// If so the bracketed text is not a link at all.
function labelHasHtml(full, label, offset) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const i = R_CODE_SPAN.exec(label.slice(s));
      if (i) { s += i[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const r = full.slice(offset + s);
    const o = R_TAG.exec(r) || R_AUTOLINK.exec(r);
    if (o) {
      if (o[0].length > label.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Block grammar (GFM)
// ---------------------------------------------------------------------------

const R_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const R_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const R_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const R_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const R_HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const R_BULL = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const R_LHEADING_SRC = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const R_PARA_SRC = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const R_TEXT = /^[^\n]+/;

function paraRegex(listPattern) {
  return edit(R_PARA_SRC)
    .replace('hr', R_HR)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '')
    .replace('|table', '')
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', listPattern)
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', K)
    .getRegex();
}

const R_TABLE = edit("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)")
  .replace('hr', R_HR)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', K)
  .getRegex();

const R_PARAGRAPH = edit(R_PARA_SRC)
  .replace('hr', R_HR)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('table', R_TABLE)
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', K)
  .getRegex();

const R_LHEADING = edit(R_LHEADING_SRC)
  .replace(/bull/g, R_BULL)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .getRegex();

const R_BLOCKQUOTE = edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).replace('paragraph', paraRegex(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/)).getRegex();
const R_LIST = edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, R_BULL).getRegex();

const R_LABEL_REF = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const R_DEF = edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', R_LABEL_REF)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .getRegex();

const R_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const R_HTML = edit("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))", 'i')
  .replace('comment', R_COMMENT)
  .replace('tag', K)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .getRegex();


// ---------------------------------------------------------------------------
// Inline grammar (GFM)
// ---------------------------------------------------------------------------

const R_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const R_CODE_SPAN = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const R_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const R_PUNCT = /[\p{P}\p{S}]/u;
const R_PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const R_NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const R_PUNCT_TILDE = /(?!~)[\p{P}\p{S}]/u;
const R_PUNCT_SPACE_TILDE = /(?!~)[\s\p{P}\p{S}]/u;
const R_NOT_PUNCT_SPACE_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;
const R_PUNCTUATION = edit(/^((?![*_])punctSpace)/, 'u').replace(/punctSpace/g, R_PUNCT_SPACE).getRegex();
const R_ANY_PUNCT = edit(/\\(punct)/, 'gu').replace(/punct/g, R_PUNCT).getRegex();
const R_ANY_PUNCT_OUTSIDE_CODE = edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu').replace(/punct/g, R_PUNCT).getRegex();

// Emphasis delimiter patterns.
const LDELIM_SRC = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const R_EM_STRONG_L_DELIM = edit(LDELIM_SRC, 'u').replace(/punct/g, R_PUNCT_TILDE).getRegex();
const RDELIM_AST_SRC = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
const R_EM_STRONG_R_DELIM_AST = edit(RDELIM_AST_SRC, 'gu')
  .replace(/notPunctSpace/g, R_NOT_PUNCT_SPACE_TILDE)
  .replace(/punctSpace/g, R_PUNCT_SPACE_TILDE)
  .replace(/punct/g, R_PUNCT_TILDE)
  .getRegex();
const RDELIM_UND_SRC = "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)";
const R_EM_STRONG_R_DELIM_UND = edit(RDELIM_UND_SRC, 'gu')
  .replace(/notPunctSpace/g, R_NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, R_PUNCT_SPACE)
  .replace(/punct/g, R_PUNCT)
  .getRegex();

// Strikethrough delimiters.
const R_DEL_L_DELIM = edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').replace(/punct/g, R_PUNCT).getRegex();
const RDELIM_DEL_SRC = "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)";
const R_DEL_R_DELIM = edit(RDELIM_DEL_SRC, 'gu')
  .replace(/notPunctSpace/g, R_NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, R_PUNCT_SPACE)
  .replace(/punct/g, R_PUNCT)
  .getRegex();
const R_DEL = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

// Autolinks, tags, links.
const R_AUTOLINK = edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .getRegex();
const R_TAG_COMMENT = edit(R_COMMENT).replace('(?:-->|$)', '-->').getRegex();
const R_TAG = edit("^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>")
  .replace('comment', R_TAG_COMMENT)
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .getRegex();

// Link label patterns.
const R_BRACKET_PAIR = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const R_LABEL = edit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).replace('brackets', R_BRACKET_PAIR).getRegex();
const R_LABEL_SEARCH = edit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/).replace('brackets', R_BRACKET_PAIR).getRegex();
const R_REF_999 = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const R_LINK = edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', R_LABEL)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .getRegex();
const R_REFLINK = edit(/^!?\[(label)\]\[(ref)\]/).replace('label', R_LABEL).replace('ref', R_LABEL_REF).getRegex();
const R_NOLINK = edit(/^!?\[(ref)\](?:\[\])?/).replace('ref', R_LABEL_REF).getRegex();
const R_REFLINK_SEARCH = edit('reflink|nolink(?!\\()', 'g')
  .replace('reflink', edit(/^!?\[(label)\]\[(ref)\]/).replace('label', R_LABEL_SEARCH).replace('ref', R_REF_999).getRegex())
  .replace('nolink', edit(/^!?\[(ref)\](?:\[\])?/).replace('ref', R_REF_999).getRegex())
  .getRegex();
const R_BLOCK_SKIP = edit(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', '(?<!`)()')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();

// Extended autolinks (GFM).
const R_PROTOCOL = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const R_EMAIL = /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const R_EMAIL_NOGROUP = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const R_EMAIL_PROTOCOL = edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).replace(/email/g, R_EMAIL_NOGROUP).getRegex();
const R_URL = edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', R_EMAIL_PROTOCOL)
  .replace('protocol', R_PROTOCOL)
  .replace('email', R_EMAIL)
  .getRegex();
const R_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// Inline text: stops just before the next inline construct.
const R_INLINE_TEXT = edit(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .replace('protocol', R_PROTOCOL)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', '(?<![^\\s*_~(])www\\.')
  .getRegex();

// ---------------------------------------------------------------------------
// Per-parse context
// ---------------------------------------------------------------------------

function makeCtx() {
  return {
    links: Object.create(null),
    queue: [], // {src, html} — inline work deferred until all defs are known
    state: { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true },
    maskStack: [], // {masked, emStar, emUnd, del}
  };
}

function queueInline(ctx, src) {
  const e = { src, html: null };
  ctx.queue.push(e);
  return e;
}

// ---------------------------------------------------------------------------
// Emphasis masking: hide links, code and escaped punctuation from the
// delimiter scan, so a * inside a code span never counts as emphasis.
// ---------------------------------------------------------------------------

function scanDelims(a) {
  const em = { '*': -1, '_': -1 };
  let del = -1;
  const n = a.length;
  for (let s = 0; s < n; s++) {
    const r = a[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const o = s === 0 ? '\n' : a[s - 1];
    let i = s + 1;
    while (i < n && a[i] === r) i++;
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') {
      if (r === '~') del = s;
      else em[r] = s;
    }
    s = i - 1;
  }
  return { masked: a, em, del };
}

function lastEmCloser(ctx, masked, ch) {
  const top = ctx.maskStack[ctx.maskStack.length - 1];
  if (top && top.masked === masked) return top.em[ch];
  return scanDelims(masked).em[ch];
}

function lastDelCloser(ctx, masked) {
  const top = ctx.maskStack[ctx.maskStack.length - 1];
  if (top && top.masked === masked) return top.del;
  return scanDelims(masked).del;
}

function linkInText(e, ctx) {
  if (!e.includes('[')) return false;
  for (const n of e.matchAll(R_BLOCK_SKIP)) {
    if (R_LINK.test(n[0]) && e.charAt(n.index - 1) !== '!') return true;
  }
  for (const n of e.matchAll(R_REFLINK_SEARCH)) {
    const s = n[0], r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(ctx.links, normalizeLabel(s.slice(r + 1, -1)))) &&
        !(r > 1 && linkInText(s.slice(1, r - 1), ctx))) return true;
  }
  return false;
}

function maskSrc(e, ctx) {
  let t = e;
  if (ctx.links && e.includes('[')) {
    const re = R_REFLINK_SEARCH;
    const s = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(ctx.links, normalizeLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(inner, ctx)) return '[' + inner.replace(re, s) + '][' + 'a'.repeat(r.length - o - 2) + ']';
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(re, s);
  }
  if (t.includes('`') || t.includes('\\')) t = t.replace(R_ANY_PUNCT_OUTSIDE_CODE, (n, g1, g2) =>
    g2 ? '+'.repeat(n.length) : g1 ? g1 + n.slice(g1.length, -g1.length).replace(/`/g, '+') + g1 : n);
  if (t.includes('[') || t.includes('`') || t.includes('<')) t = t.replace(R_BLOCK_SKIP, (n, g1, g2) => {
    const o = g2 ? g2.length : 0;
    return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']';
  });
  return t;
}

// ---------------------------------------------------------------------------
// Inline rendering (mode 'html' = normal, 'text' = plain-text alt text)
// ---------------------------------------------------------------------------

function inlineTokens(src, ctx, mode) {
  const saved = ctx.state.linkParenPossible;
  ctx.state.linkParenPossible = saved && src.includes(')');
  try {
    return inlineInner(src, ctx, mode);
  } finally {
    ctx.state.linkParenPossible = saved;
  }
}

function inlineInner(src, ctx, mode) {
  const hasDelim = src.includes('*') || src.includes('_') || src.includes('~');
  const masked = hasDelim ? maskSrc(src, ctx) : src;
  ctx.maskStack.push(hasDelim ? scanDelims(masked) : { masked, em: { '*': -1, '_': -1 }, del: -1 });
  try {
    return inlineLoop(src, masked, ctx, mode);
  } finally {
    ctx.maskStack.pop();
  }
}

function inlineLoop(src, masked, ctx, mode) {
  const textMode = mode === 'text';
  let out = '';
  let wasText = false;
  let prevChar = '';
  let guard = Infinity;
  while (src) {
    if (src.length >= guard) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    guard = src.length;
    if (!wasText) prevChar = '';
    wasText = false;
    let m;
    // escape: \* -> *
    if ((m = R_ESCAPE.exec(src))) {
      src = src.slice(m[0].length);
      out += textMode ? m[1] : escNoEncode(m[1]);
      continue;
    }
    // raw html tag (also flips inLink / inRawBlock state)
    if ((m = R_TAG.exec(src))) {
      if (!ctx.state.inLink && T.startATag.test(m[0])) ctx.state.inLink = true;
      else if (ctx.state.inLink && T.endATag.test(m[0])) ctx.state.inLink = false;
      if (!ctx.state.inRawBlock && T.startPreScriptTag.test(m[0])) ctx.state.inRawBlock = true;
      else if (ctx.state.inRawBlock && T.endPreScriptTag.test(m[0])) ctx.state.inRawBlock = false;
      src = src.slice(m[0].length);
      out += m[0];
      continue;
    }
    // inline link / image
    if ((m = parseLink(src, ctx, mode))) {
      src = src.slice(m.raw.length);
      out += m.html;
      continue;
    }
    // reference link / shortcut link
    if ((m = parseReflink(src, ctx, mode))) {
      src = src.slice(m.raw.length);
      out += m.html;
      continue;
    }
    // emphasis / strong
    if ((m = parseEmStrong(src, masked, prevChar, ctx, mode))) {
      src = src.slice(m.raw.length);
      out += m.html;
      continue;
    }
    // code span
    if ((m = R_CODE_SPAN.exec(src))) {
      src = src.slice(m[0].length);
      let txt = m[2].replace(T.newLineCharGlobal, ' ');
      if (T.nonSpaceChar.test(txt) && T.startingSpaceChar.test(txt) && T.endingSpaceChar.test(txt)) txt = txt.substring(1, txt.length - 1);
      out += textMode ? txt : '<code>' + escEncode(txt) + '</code>';
      continue;
    }
    // hard break
    if ((m = R_BR.exec(src))) {
      src = src.slice(m[0].length);
      out += textMode ? '' : '<br>';
      continue;
    }
    // strikethrough
    if ((m = parseDel(src, masked, prevChar, ctx, mode))) {
      src = src.slice(m.raw.length);
      out += m.html;
      continue;
    }
    // autolink <http://...> / <foo@bar>
    if ((m = R_AUTOLINK.exec(src))) {
      src = src.slice(m[0].length);
      let n, s;
      if (m[2] === '@') { n = m[1]; s = 'mailto:' + n; } else { n = m[1]; s = n; }
      out += textMode ? n : autolinkHtml(n, s);
      continue;
    }
    // extended autolink (GFM): www. / protocol:// / bare email
    if (!ctx.state.inLink && (m = parseUrl(src, ctx))) {
      src = src.slice(m.raw.length);
      out += textMode ? m.text : m.html;
      continue;
    }
    // plain text run
    if ((m = R_INLINE_TEXT.exec(src))) {
      src = src.slice(m[0].length);
      const inRaw = ctx.state.inRawBlock;
      const text = inRaw ? m[0] : unescapeNumeric(m[0]);
      if (m[0].slice(-1) !== '_') prevChar = m[0].slice(-1);
      wasText = true;
      out += textMode ? text : (inRaw ? text : escNoEncode(text));
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  return out;
}

function autolinkHtml(text, href) {
  const o = escEncode(text);
  const i = cleanUrl(href);
  if (i === null) return o;
  return '<a href="' + escEncode(i) + '">' + o + '</a>';
}

// Build a link/image from a matched token `t` and {href, title}.
// Returns {raw, html, text?} or null when a nested link forbids the outer one.
function makeLink(t, e, raw, ctx, mode) {
  const href = e.href, title = e.title || null;
  const label = t[1].replace(T.outputLinkReplace, '$1');
  const isImage = t[0].charAt(0) === '!';
  const p = ctx.state.inLink, h = ctx.state.linkEmitted, u = ctx.state.inRawBlock;
  ctx.state.inLink = true;
  ctx.state.linkEmitted = false;
  // Images render their label as plain text (alt); links render it inline.
  const inner = inlineTokens(label, ctx, isImage ? 'text' : mode);
  const k = ctx.state.linkEmitted;
  ctx.state.linkEmitted = h;
  ctx.state.inLink = p;
  if (!isImage) {
    if (k) { ctx.state.inRawBlock = u; return null; }
    ctx.state.linkEmitted = true;
  }
  if (mode === 'text') return { raw, html: inner };
  if (isImage) {
    if (mode === 'text') return { raw, html: inner };
    const i = cleanUrl(href);
    if (i === null) return { raw, html: escNoEncode(inner) };
    let o = '<img src="' + escNoEncode(i) + '" alt="' + escNoEncode(inner) + '"';
    if (title) o += ' title="' + escNoEncode(title) + '"';
    return { raw, html: o + '>' };
  }
  const i = cleanUrl(href);
  if (i === null) return { raw, html: inner };
  let l = '<a href="' + escNoEncode(i) + '"';
  if (title) l += ' title="' + escNoEncode(title) + '"';
  return { raw, html: l + '>' + inner + '</a>' };
}

function parseLink(src, ctx, mode) {
  if (!ctx.state.linkParenPossible) return null;
  const t = R_LINK.exec(src);
  if (!t) return null;
  const bang = t[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasHtml(src, t[1], bang)) return null;
  const s = t[2].trim();
  if (T.startAngleBracket.test(s)) {
    if (!T.endAngleBracket.test(s)) return null;
    const l = rtrim(s.slice(0, -1), '\\');
    if ((s.length - l.length) % 2 === 0) return null;
  } else {
    const l = findClosingBracket(t[2], '()');
    if (l === -2) return null;
    if (l > -1) {
      const h = (t[0].indexOf('!') === 0 ? 5 : 4) + t[1].length + l;
      t[2] = t[2].substring(0, l);
      t[0] = t[0].substring(0, h).trim();
      t[3] = '';
    }
  }
  const rr = rtrim(t[0].slice(0, -1), '\\');
  if ((t[0].length - rr.length) % 2 === 0) return null;
  let o = t[2], i = '';
  i = t[3] ? t[3].slice(1, -1) : '';
  o = o.trim();
  if (T.startAngleBracket.test(o)) o = o.slice(1, -1);
  return makeLink(t, { href: o && o.replace(R_ANY_PUNCT, '$1'), title: i && i.replace(R_ANY_PUNCT, '$1') }, t[0], ctx, mode);
}

function parseReflink(src, ctx, mode) {
  const m = R_REFLINK.exec(src) || R_NOLINK.exec(src);
  if (!m) return null;
  const bang = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasHtml(src, m[1], bang)) return null;
  const link = ctx.links[normalizeLabel(m[2] || m[1])];
  if (!link) {
    const ch = m[0].charAt(0);
    return { raw: ch, html: mode === 'text' ? ch : escNoEncode(ch) };
  }
  return makeLink(m, link, m[0], ctx, mode);
}

function parseEmStrong(src, masked, prevChar, ctx, mode) {
  const s = R_EM_STRONG_L_DELIM.exec(src);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const r = s[0][0];
  const o = prevChar === r;
  const i = masked.length - src.length;
  let l = i;
  while (l > 0 && masked[l - 1] === r) l--;
  const p = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = p === '*' || p === '_' || !!R_PUNCTUATION.exec(p);
  if (l < i) prevChar = p;
  const u = l < i ? h : !!R_PUNCTUATION.exec(prevChar);
  if (s[4] && prevChar.match(T.unicodeAlphaNumeric)) return null;
  const d = s[1] || s[3] || '';
  if (!d || !prevChar || u) {
    const k = [...s[0]].length - 1;
    let g, b, m = k, f = 0;
    const y = i - l + k;
    const R = !!p.trim() && (!!d || (r === '*' && !h));
    if (r !== '*' && r !== '_') return null;
    const A = r === '*' ? R_EM_STRONG_R_DELIM_AST : R_EM_STRONG_R_DELIM_UND;
    const v = lastEmCloser(ctx, masked, r);
    const Q = masked.length - src.length + k;
    if (v < Q) return null;
    const t = masked.slice(-1 * src.length + k);
    const ee = v - Q;
    A.lastIndex = 0;
    let m2;
    while ((m2 = A.exec(t)) !== null && !(m2.index > ee)) {
      g = m2[1] || m2[2] || m2[3] || m2[4] || m2[5] || m2[6];
      if (!g) continue;
      b = [...g].length;
      if (m2[3] || m2[4]) { m += b; continue; }
      else if (m2[5] || m2[6] || R) {
        if (o && (m2[5] || m2[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      m -= b;
      if (m > 0) continue;
      b = Math.min(b, b + m + f);
      const te = [...m2[0]][0].length;
      const M = src.slice(0, k + m2.index + te + b);
      if (Math.min(k, b) % 2) {
        const U = M.slice(1, -1);
        return { raw: M, html: mode === 'text' ? inlineTokens(U, ctx, mode) : '<em>' + inlineTokens(U, ctx, mode) + '</em>' };
      }
      const ne = M.slice(2, -2);
      return { raw: M, html: mode === 'text' ? inlineTokens(ne, ctx, mode) : '<strong>' + inlineTokens(ne, ctx, mode) + '</strong>' };
    }
  }
  return null;
}

function parseDel(src, masked, prevChar, ctx, mode) {
  const s = R_DEL_L_DELIM.exec(src);
  if (!s) return null;
  const canOpen = !(s[1] || '') || !prevChar || !!R_PUNCTUATION.exec(prevChar);
  if (!canOpen) return null;
  const o = [...s[0]].length - 1;
  let i, l, p = o;
  const h = R_DEL_R_DELIM;
  const u = lastDelCloser(ctx, masked);
  const d = masked.length - src.length + o;
  if (u < d) return null;
  const t = masked.slice(-1 * src.length + o);
  const k = u - d;
  h.lastIndex = 0;
  let m2;
  while ((m2 = h.exec(t)) !== null && !(m2.index > k)) {
    i = m2[1] || m2[2] || m2[3] || m2[4] || m2[5] || m2[6];
    if (!i) continue;
    l = [...i].length;
    if (l !== o) continue;
    if (m2[3] || m2[4]) { p += l; continue; }
    p -= l;
    if (p > 0) continue;
    l = Math.min(l, l + p);
    const g = [...m2[0]][0].length;
    const b = src.slice(0, o + m2.index + g + l);
    const inner = b.slice(o, -o);
    return { raw: b, html: mode === 'text' ? inlineTokens(inner, ctx, mode) : '<del>' + inlineTokens(inner, ctx, mode) + '</del>' };
  }
  return null;
}

function parseUrl(src, ctx) {
  const t = R_URL.exec(src);
  if (!t) return null;
  let n, s;
  if (t[2] === '@') {
    n = t[0];
    s = 'mailto:' + n;
  } else {
    let r;
    do {
      r = t[0];
      t[0] = R_BACKPEDAL.exec(t[0])?.[0] ?? '';
    } while (r !== t[0]);
    n = t[0];
    s = t[1] === 'www.' ? 'http://' + t[0] : t[0];
  }
  return { raw: t[0], text: n, html: autolinkHtml(n, s) };
}

// ---------------------------------------------------------------------------
// Block parsing. Nodes are light objects; paragraph / heading / table-cell
// text is queued and rendered inline only after the whole document has been
// scanned (link reference definitions may come after their use).
// ---------------------------------------------------------------------------

function blockParse(src, nodes, mergePara, ctx) {
  let guard = Infinity;
  while (src) {
    if (src.length >= guard) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    guard = src.length;
    let m;
    // blank lines
    if ((m = R_NEWLINE.exec(src))) {
      src = src.slice(m[0].length);
      const last = nodes[nodes.length - 1];
      if (m[0].length === 1 && last !== undefined) last.raw += '\n';
      else nodes.push({ t: 'space', raw: m[0] });
      continue;
    }
    // indented code
    if ((m = R_CODE.exec(src))) {
      const raw = stripTrailingBlanks(m[0]);
      src = src.slice(raw.length);
      const text = raw.replace(T.codeRemoveIndent, '');
      const last = nodes[nodes.length - 1];
      if (last && (last.t === 'paragraph' || last.t === 'text')) {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + raw;
        last.text += '\n' + text;
        ctx.queue[ctx.queue.length - 1].src = last.text;
      } else {
        nodes.push({ t: 'code', raw, text });
      }
      continue;
    }
    // fenced code
    if ((m = R_FENCES.exec(src))) {
      src = src.slice(m[0].length);
      nodes.push({
        t: 'code', raw: m[0],
        lang: m[2] ? m[2].trim().replace(R_ANY_PUNCT, '$1') : m[2],
        text: fenceDedent(m[0], m[3] || ''),
      });
      continue;
    }
    // ATX heading
    if ((m = R_HEADING.exec(src))) {
      src = src.slice(m[0].length);
      let text = m[2].trim();
      if (T.endingHash.test(text)) {
        const s = rtrim(text, '#');
        if (!s || T.endingSpaceTabChar.test(s)) text = s.trim();
      }
      nodes.push({ t: 'heading', raw: rtrim(m[0], '\n'), depth: m[1].length, text, entry: queueInline(ctx, text) });
      continue;
    }
    // thematic break
    if ((m = R_HR.exec(src))) {
      src = src.slice(m[0].length);
      nodes.push({ t: 'hr', raw: rtrim(m[0], '\n') });
      continue;
    }
    // block quote
    if ((m = parseBlockquote(src, ctx))) {
      src = src.slice(m.raw.length);
      nodes.push(m);
      continue;
    }
    // list
    if ((m = parseList(src, ctx))) {
      src = src.slice(m.raw.length);
      nodes.push(m);
      continue;
    }
    // raw html block
    if ((m = R_HTML.exec(src))) {
      const raw = stripTrailingBlanks(m[0]);
      src = src.slice(raw.length);
      nodes.push({ t: 'html', raw, text: raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style' });
      continue;
    }
    // link reference definition
    if ((m = R_DEF.exec(src))) {
      if (!T.startAngleBracket.test(m[2]) && findClosingBracket(m[2], '()') !== -1) {
        // not a definition after all: fall through to the other rules
      } else {
        const tag = normalizeLabel(m[1]);
        const href = m[2] ? m[2].replace(T.hrefBrackets, '$1').replace(R_ANY_PUNCT, '$1') : '';
        const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(R_ANY_PUNCT, '$1') : m[3];
        const raw = rtrim(m[0], '\n');
        src = src.slice(raw.length);
        const last = nodes[nodes.length - 1];
        if (last && (last.t === 'paragraph' || last.t === 'text')) {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + raw;
          last.text += '\n' + raw;
          ctx.queue[ctx.queue.length - 1].src = last.text;
        } else {
          if (!ctx.links[tag]) ctx.links[tag] = { href, title };
          nodes.push({ t: 'def', raw });
        }
        continue;
      }
    }
    // table
    if ((m = parseTable(src, ctx))) {
      src = src.slice(m.raw.length);
      nodes.push(m);
      continue;
    }
    // setext heading
    if ((m = R_LHEADING.exec(src))) {
      src = src.slice(m[0].length);
      const text = m[1].trim();
      nodes.push({ t: 'heading', raw: rtrim(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text, entry: queueInline(ctx, text) });
      continue;
    }
    // paragraph (only at the top level of a block run)
    if (ctx.state.top && (m = R_PARAGRAPH.exec(src))) {
      const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
      const entry = queueInline(ctx, text);
      const last = nodes[nodes.length - 1];
      if (mergePara && last?.t === 'paragraph') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + m[0];
        last.text += '\n' + text;
        ctx.queue.pop();
        ctx.queue[ctx.queue.length - 1].src = last.text;
      } else {
        nodes.push({ t: 'paragraph', raw: m[0], text, entry });
      }
      mergePara = false;
      src = src.slice(m[0].length);
      continue;
    }
    // plain text line (inside list items, where top is false)
    if ((m = R_TEXT.exec(src))) {
      src = src.slice(m[0].length);
      const entry = queueInline(ctx, m[0]);
      const last = nodes[nodes.length - 1];
      if (last?.t === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + m[0];
        last.text += '\n' + m[0];
        ctx.queue.pop();
        ctx.queue[ctx.queue.length - 1].src = last.text;
      } else {
        nodes.push({ t: 'text', raw: m[0], text: m[0], entry });
      }
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  ctx.state.top = true;
  return nodes;
}

function parseBlockquote(src, ctx) {
  const m = R_BLOCKQUOTE.exec(src);
  if (!m) return null;
  let lines = rtrim(m[0], '\n').split('\n');
  let s = '', r = '';
  const nodes = [];
  while (lines.length > 0) {
    let started = false;
    const l = [];
    let p = 0;
    for (p = 0; p < lines.length; p++) {
      if (T.blockquoteStart.test(lines[p])) { l.push(lines[p]); started = true; }
      else if (!started) l.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const h = l.join('\n');
    const u = h
      .replace(T.blockquoteMarkerWhitespace, (g, b, mm) => b + expandTabs(mm, b.length))
      .replace(T.blockquoteSetextReplace, '\n    $1')
      .replace(T.blockquoteSetextReplace2, '');
    s = s ? s + '\n' + h : h;
    r = r ? r + '\n' + u : u;
    const d = ctx.state.top;
    ctx.state.top = true;
    blockParse(u, nodes, true, ctx);
    ctx.state.top = d;
    if (lines.length === 0) break;
    const k = nodes[nodes.length - 1];
    if (k && (k.t === 'code' || k.t === 'heading' || k.t === 'hr' || k.t === 'html' || k.t === 'table')) break;
    if (k?.t === 'blockquote') {
      const g = k;
      const b = lines.join('\n');
      const mm = g.raw + '\n' + b.replace(T.blockquoteSetextReplace2, '');
      const f = parseBlockquote(mm, ctx);
      nodes[nodes.length - 1] = f;
      const y = mm.substring(f.raw.length).replace(/^\n/, '');
      const R = y ? y.split('\n').length : 0;
      const A = R ? lines.slice(0, -R) : lines;
      if (A.length > 0) s = s + '\n' + A.join('\n');
      r = r.substring(0, r.length - g.text.length) + f.text;
      lines = lines.slice(A.length);
      if (lines.length > 0 && T.blockquoteStart.test(lines[0])) continue;
      break;
    } else if (k?.t === 'list') {
      const g = k;
      const b = g.raw + '\n' + lines.join('\n');
      const mm = parseList(b, ctx);
      nodes[nodes.length - 1] = mm;
      const f = mm.raw.length > g.raw.length ? b.slice(g.raw.length + 1, mm.raw.length).split('\n').length : 0;
      if (f > 0) {
        const y = lines.slice(0, f).join('\n');
        s = s + '\n' + y;
        r = r + '\n' + y;
      }
      lines = lines.slice(f);
      continue;
    }
  }
  return { t: 'blockquote', raw: s, text: r, nodes };
}

function parseList(src, ctx) {
  const m = R_LIST.exec(src);
  if (!m) return null;
  const full = src;
  const bulletRaw = m[1].trim();
  const ordered = bulletRaw.length > 1;
  const list = {
    t: 'list', raw: '', ordered,
    start: ordered ? +bulletRaw.slice(0, -1) : '',
    loose: false, items: [],
  };
  const bullPat = ordered ? `\\d{1,9}\\${bulletRaw.slice(-1)}` : `\\${bulletRaw}`;
  const itemRe = T.listItemRegex(bullPat);
  let p = false;
  let rem = src;
  while (rem) {
    let u = false, d = '';
    const t = itemRe.exec(rem);
    if (!t || R_HR.test(rem)) break;
    const k = full.length - rem.length;
    rem = rem.slice(t[0].length);
    const g = t[2].split('\n', 1)[0];
    const b = t[1].length;
    let mm = g.replace(T.leadingSpaceTab, (v) => expandTabs(v, b));
    let f = rem.split('\n', 1)[0];
    let y = !mm.trim();
    let R = 0;
    if (y) R = b + 1;
    else {
      R = mm.search(T.nonSpaceChar);
      R = R > 4 ? 1 : R;
      d = mm.slice(R);
      R += b;
    }
    if (y && T.blankLine.test(f)) {
      rem = rem.slice(f.length + 1);
      u = true;
    }
    if (!u) {
      const v = T.nextBulletRegex(R), Q = T.hrRegex(R), ee = T.fencesBeginRegex(R),
        te = T.headingBeginRegex(R), M = T.htmlBeginRegex(R), ne = T.blockquoteBeginRegex(R);
      while (rem) {
        const U = rem.split('\n', 1)[0];
        f = U;
        const Z = f.replace(T.leadingSpaceTab, (me) => expandTabs(me));
        if (ee.test(f) || te.test(f) || M.test(f) || ne.test(f) || v.test(f) || Q.test(f)) break;
        if (Z.search(T.nonSpaceChar) >= R || !f.trim()) d += '\n' + Z.slice(R);
        else {
          if (y || mm.replace(T.tabCharGlobal, '    ').search(T.nonSpaceChar) >= 4 || ee.test(mm) || te.test(mm) || M.test(mm) || Q.test(mm)) break;
          const qe = /^ {0,3}(?:=+|-+) *$/.test(f) && R_LHEADING.test(mm + '\n' + f)
            ? '    ' + Z.replace(/^ {0,3}/, '')
            : f;
          d += '\n' + qe;
        }
        y = !f.trim();
        rem = rem.slice(U.length + 1);
        mm = Z.slice(R);
      }
    }
    const A = full.slice(k, full.length - rem.length);
    if (!list.loose) {
      if (p) list.loose = true;
      else if (T.doubleBlankLine.test(A)) p = true;
    }
    list.items.push({ t: 'list_item', raw: A, task: T.listIsTask.test(d), loose: false, text: d, nodes: [] });
  }
  const h = list.items[list.items.length - 1];
  if (h) {
    h.raw = h.raw.trimEnd();
    h.text = h.text.trimEnd();
  } else return null;
  list.raw = full.slice(0, full.length - rem.length).trimEnd();
  for (const u of list.items) {
    ctx.state.top = false;
    u.nodes = blockParse(u.text, [], false, ctx);
    if (!list.loose) {
      const spaces = u.nodes.filter((g) => g.t === 'space');
      list.loose = spaces.length > 0 && spaces.some((g) => T.anyLine.test(g.raw));
    }
  }
  for (const u of list.items) {
    const d0 = u.nodes[0];
    if (u.task && (d0?.t === 'text' || d0?.t === 'paragraph')) {
      u.text = u.text.replace(T.listReplaceTask, '');
      d0.raw = d0.raw.replace(T.listReplaceTask, '');
      d0.text = d0.text.replace(T.listReplaceTask, '');
      for (let g = ctx.queue.length - 1; g >= 0; g--) {
        if (T.listIsTask.test(ctx.queue[g].src)) {
          ctx.queue[g].src = ctx.queue[g].src.replace(T.listReplaceTask, '');
          break;
        }
      }
      const kk = T.listTaskCheckbox.exec(u.raw);
      if (kk) {
        const cb = { t: 'checkbox', raw: kk[0] + ' ', checked: kk[0] !== '[ ]' };
        u.checked = cb.checked;
        if (list.loose) {
          if (u.nodes[0] && (u.nodes[0].t === 'paragraph' || u.nodes[0].t === 'text') && 'entry' in u.nodes[0]) {
            u.nodes[0].raw = cb.raw + u.nodes[0].raw;
            u.nodes[0].text = cb.raw + u.nodes[0].text;
            u.nodes[0].prefix = checkboxHtml(cb.checked);
          } else {
            u.nodes.unshift({ t: 'paragraph', raw: cb.raw, text: cb.raw, entry: null, prefix: checkboxHtml(cb.checked) });
          }
        } else {
          u.nodes.unshift(cb);
        }
      }
    } else if (u.task) u.task = false;
  }
  if (list.loose) {
    for (const u of list.items) {
      u.loose = true;
      for (const d of u.nodes) if (d.t === 'text') d.t = 'paragraph';
    }
  }
  return list;
}

function parseTable(src, ctx) {
  const m = R_TABLE.exec(src);
  if (!m || !T.tableDelimiter.test(m[2])) return null;
  const headerCells = splitCells(m[1]);
  const delim = m[2].replace(T.tableAlignChars, '').split('|');
  const rowLines = m[3]?.trim() ? m[3].replace(T.tableRowBlankLine, '').split('\n') : [];
  const table = { t: 'table', raw: rtrim(m[0], '\n'), header: [], align: [], rows: [] };
  if (headerCells.length === delim.length) {
    for (const c of delim) {
      if (T.tableAlignRight.test(c)) table.align.push('right');
      else if (T.tableAlignCenter.test(c)) table.align.push('center');
      else if (T.tableAlignLeft.test(c)) table.align.push('left');
      else table.align.push(null);
    }
    for (let i = 0; i < headerCells.length; i++) {
      table.header.push({ text: headerCells[i], entry: queueInline(ctx, headerCells[i]), header: true, align: table.align[i] });
    }
    for (const line of rowLines) {
      const cells = splitCells(line, table.header.length);
      table.rows.push(cells.map((c, pi) => ({ text: c, entry: queueInline(ctx, c), header: false, align: table.align[pi] })));
    }
    return table;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function checkboxHtml(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function codeHtml(node) {
  const lang = (node.lang || '').match(T.notSpaceStart)?.[0];
  const r = node.text ? node.text.replace(T.endingNewline, '') + '\n' : '';
  const body = escEncode(r);
  return lang
    ? '<pre><code class="language-' + escNoEncode(lang) + '">' + body + '</code></pre>\n'
    : '<pre><code>' + body + '</code></pre>\n';
}

function renderNodes(nodes) {
  let out = '';
  for (const n of nodes) {
    switch (n.t) {
      case 'space': break;
      case 'hr': out += '<hr>\n'; break;
      case 'code': out += codeHtml(n); break;
      case 'heading': out += '<h' + n.depth + '>' + (n.entry ? n.entry.html : '') + '</h' + n.depth + '>\n'; break;
      case 'blockquote': out += '<blockquote>\n' + renderNodes(n.nodes) + '</blockquote>\n'; break;
      case 'html': out += n.text; break;
      case 'def': break;
      case 'paragraph': out += '<p>' + (n.prefix || '') + (n.entry ? n.entry.html : '') + '</p>\n'; break;
      case 'text': out += (n.prefix || '') + (n.entry ? n.entry.html : ''); break;
      case 'checkbox': out += checkboxHtml(n.checked); break;
      case 'table': {
        let headCells = '';
        for (const c of n.header) headCells += tableCellHtml(c);
        let body = '';
        for (const row of n.rows) {
          let cells = '';
          for (const c of row) cells += tableCellHtml(c);
          body += '<tr>\n' + cells + '</tr>\n';
        }
        if (body) body = '<tbody>' + body + '</tbody>';
        out += '<table>\n<thead>\n<tr>\n' + headCells + '</tr>\n</thead>\n' + body + '</table>\n';
        break;
      }
      case 'list': {
        let s = '';
        for (const item of n.items) s += '<li>' + renderNodes(item.nodes) + '</li>\n';
        const tag = n.ordered ? 'ol' : 'ul';
        const start = n.ordered && n.start !== 1 ? ' start="' + n.start + '"' : '';
        out += '<' + tag + start + '>\n' + s + '</' + tag + '>\n';
        break;
      }
    }
  }
  return out;
}

function tableCellHtml(c) {
  const tag = c.header ? 'th' : 'td';
  return (c.align ? '<' + tag + ' align="' + c.align + '">' : '<' + tag + '>') +
    (c.entry ? c.entry.html : '') + '</' + tag + '>\n';
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  if (typeof markdown !== 'string') {
    throw new Error('marked(): input parameter is of type ' + Object.prototype.toString.call(markdown) + ', string expected');
  }
  const ctx = makeCtx();
  const nodes = blockParse(markdown.replace(T.carriageReturn, '\n'), [], false, ctx);
  for (const q of ctx.queue) {
    ctx.state.inRawBlock = false;
    q.html = inlineTokens(q.src, ctx, 'html');
  }
  return renderNodes(nodes);
}
