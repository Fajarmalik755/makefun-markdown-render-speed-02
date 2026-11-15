// parse.js — a fast CommonMark 0.31.2 + GFM 0.29 renderer.
//
// parse(markdown) returns exactly the HTML marked 18.1.3 renders with its
// default options (gfm on, breaks off, pedantic off, async off). It is a
// from-scratch implementation: an index-based scanner over the source
// string, with no dependency, no intermediate token tree for inline runs,
// and no state kept between calls.
//
// The behaviour follows marked's rule set (its block and inline grammars
// and its renderer) as published in marked 18.1.3 (MIT). Where marked
// departs from the spec, this follows marked.

// ---------------------------------------------------------------------------
// Pattern building
// ---------------------------------------------------------------------------

const CARET = /(^|[^\[])\^/g;

/**
 * A tiny pattern composer: start from a pattern, replace placeholder words
 * with sub-patterns, then build the regex. A `^` inside an inserted value is
 * dropped, since it would anchor mid-pattern.
 */
function edit(pattern, flags = '') {
  const api = {
    src: typeof pattern === 'string' ? pattern : pattern.source,
    replace(name, val) {
      let v = typeof val === 'string' ? val : val.source;
      v = v.replace(CARET, '$1');
      api.src = api.src.replace(name, v);
      return api;
    },
    regex() {
      return new RegExp(api.src, flags);
    },
    /**
     * Build a sticky regex: the sticky flag anchors the match at lastIndex,
     * so the leading `^` anchors (one per alternative) are dropped. A `^`
     * inside a character class is never touched.
     */
    sticky(extra = '') {
      return new RegExp(api.src.replace(/(^|\|)\^/g, '$1'), flags + extra + 'y');
    },
  };
  return api;
}

const supportsLookbehind = (() => {
  try {
    return !!new RegExp('(?<=1)(?<!1)');
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------------------
// Shared small patterns (`other`)
// ---------------------------------------------------------------------------

const O = {
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
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex(bull) {
    return new RegExp(`^( {0,3}${bull})((?:[\t ][^\n]*)?(?:\n|$))`);
  },
  nextBulletRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\n|$))`)),
  hrRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)),
  fencesBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:</?(?:${TAG})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}>`)),
};

function cachedIndentRegex(createRegex) {
  const cache = [];
  return (indent) => {
    const cacheIndex = Math.max(0, Math.min(3, indent - 1));
    let regex = cache[cacheIndex];
    if (!regex) {
      regex = createRegex(cacheIndex);
      cache[cacheIndex] = regex;
    }
    return regex;
  };
}

// ---------------------------------------------------------------------------
// Block grammar (GFM only: gfm on, pedantic off)
// ---------------------------------------------------------------------------

const BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const TAG = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';
const COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const HR_SRC = ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const HEADING_SRC = ' {0,3}#{1,6}(?:\\s|$)';
const FENCES_SRC = ' {0,3}(?:`{3,}|~{3,})';
const BLOCKQUOTE_SRC = ' {0,3}>';
const HTML_INTERRUPT_SRC = ` {0,3}(?:</?(?:${TAG})(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`;
const TABLE_INTERRUPT_SRC = ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n';

const BLOCK = {
  newline: edit(/^(?:[ \t]*(?:\n|$))+/).sticky(),
  code: edit(/^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/).sticky(),
  fences: edit(/^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/).sticky(),
  hr: edit(/^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/).sticky(),
  heading: edit(/^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/).sticky(),
  lheading: edit(/^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/)
    .replace(/bull/g, BULLET)
    .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
    .replace(/fences/g, FENCES_SRC)
    .replace(/blockquote/g, BLOCKQUOTE_SRC)
    .replace(/heading/g, HEADING_SRC)
    .replace(/hr/g, HR_SRC)
    .replace(/html/g, / {0,3}<[^\n>]+>\n/)
    .replace(/table/g, TABLE_INTERRUPT_SRC)
    .sticky(),
  list: edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
    .replace(/bull/g, BULLET)
    .sticky(),
  html: edit(
    '^ {0,3}(?:'
    + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
    + '|comment[^\\n]*(\\n+|$)'
    + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
    + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
    + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
    + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
    + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
    + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
    + ')', 'i')
    .replace('comment', COMMENT)
    .replace('tag', TAG)
    .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
    .sticky(),
  def: edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
    .replace('label', /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))*/)
    .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
    .sticky(),
  table: edit(
    '^ *([^\\n ].*)\\n'
    + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
    + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
    .replace('hr', HR_SRC)
    .replace('heading', HEADING_SRC)
    .replace('blockquote', BLOCKQUOTE_SRC)
    .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
    .replace('html', HTML_INTERRUPT_SRC)
    .sticky(),
  paragraph: edit(/^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/)
    .replace('hr', HR_SRC)
    .replace('heading', HEADING_SRC)
    .replace('|lheading', '')
    .replace('table', edit(
      '^ *([^\\n ].*)\\n'
      + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
      + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
      .replace('hr', HR_SRC)
      .replace('heading', HEADING_SRC)
      .replace('blockquote', BLOCKQUOTE_SRC)
      .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
      .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
      .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
      .replace('html', HTML_INTERRUPT_SRC)
      .regex())
    .replace('blockquote', BLOCKQUOTE_SRC)
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
    .replace('html', HTML_INTERRUPT_SRC)
    .sticky(),
  text: edit(/^[^\n]+/).sticky(),
};

const BLOCKQUOTE_PARAGRAPH = edit(/^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/)
  .replace('hr', HR_SRC)
  .replace('heading', HEADING_SRC)
  .replace('|lheading', '')
  .replace('|table', '')
  .replace('blockquote', BLOCKQUOTE_SRC)
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)')
  .replace('html', HTML_INTERRUPT_SRC)
  .regex();

const BLOCKQUOTE_RE = edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
  .replace('paragraph', BLOCKQUOTE_PARAGRAPH)
  .sticky();

// ---------------------------------------------------------------------------
// Inline grammar (GFM only)
// ---------------------------------------------------------------------------

const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_GFM_STRONG = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_SPACE_GFM_STRONG = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_GFM_STRONG = /(?:[^\s\p{P}\p{S}]|~)/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;

const INLINE_LABEL_BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const INLINE_LABEL = edit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .replace('brackets', INLINE_LABEL_BRACKETS)
  .regex();
const BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const BOUNDED_BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const BOUNDED_INLINE_LABEL = edit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .replace('brackets', INLINE_LABEL_BRACKETS)
  .regex();

const CASE_INSENSITIVE_PROTOCOL = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const EXTENDED_EMAIL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EXTENDED_EMAIL_PROTOCOL = edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .replace(/email/g, EXTENDED_EMAIL)
  .regex();

const BLOCK_SKIP = edit(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', supportsLookbehind ? '(?<!`)()' : '(^^|[^`])')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .regex();

const EM_STRONG_L_DELIM = edit(/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/, 'u')
  .replace(/punct/g, PUNCT_GFM_STRONG)
  .sticky();

const EM_STRONG_R_DELIM_AST_CORE =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)' // Skip orphan inside strong
  + '|[^*]+(?=[^*])' // Consume to delim
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)' // (1) #*** can only be a Right Delimiter
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)' // (2) a***#, a*** can only be a Right Delimiter
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)' // (3) #***a, ***a can only be Left Delimiter
  + '|[\\s](\\*+)(?!\\*)(?=punct)' // (4) ***# can only be Left Delimiter
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)' // (5) #***# can be either Left or Right Delimiter
  + '|notPunctSpace(\\*+)(?=notPunctSpace)'; // (6) a***a can be either Left or Right Delimiter

const EM_STRONG_R_DELIM_AST = edit(EM_STRONG_R_DELIM_AST_CORE, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE_GFM_STRONG)
  .replace(/punctSpace/g, PUNCT_SPACE_GFM_STRONG)
  .replace(/punct/g, PUNCT_GFM_STRONG)
  .regex();

const EM_STRONG_R_DELIM_UND = edit(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)' // Skip orphan inside strong
  + '|[^_]+(?=[^_])' // Consume to delim
  + '|(?!_)punct(_+)(?=[\\s]|$)' // (1) #___ can only be a Right Delimiter
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)' // (2) a___#, a___ can only be a Right Delimiter
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)' // (3) #___a, ___a can only be Left Delimiter
  + '|[\\s](_+)(?!_)(?=punct)' // (4) ___# can only be Left Delimiter
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu') // (5) #___# can be either Left or Right Delimiter
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, PUNCT_SPACE)
  .replace(/punct/g, PUNCT)
  .regex();

const DEL_L_DELIM = edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .replace(/punct/g, PUNCT)
  .sticky();

const DEL_R_DELIM = edit(
  '^[^~]+(?=[^~])' // Consume to delim
  + '|(?!~)punct(~~?)(?=[\\s]|$)' // (1) #~~ can only be a Right Delimiter
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)' // (2) a~~#, a~~ can only be a Right Delimiter
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)' // (3) #~~a, ~~a can only be Left Delimiter
  + '|[\\s](~~?)(?!~)(?=punct)' // (4) ~~# can only be Left Delimiter
  + '|(?!~)punct(~~?)(?!~)(?=punct)' // (5) #~~# can be either Left or Right Delimiter
  + '|notPunctSpace(~~?)(?=notPunctSpace)', 'gu') // (6) a~~a can be either Left or Right Delimiter
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, PUNCT_SPACE)
  .replace(/punct/g, PUNCT)
  .regex();

const ANY_PUNCTUATION = edit(/\\(punct)/, 'gu')
  .replace(/punct/g, PUNCT)
  .regex();

const ANY_PUNCTUATION_OUTSIDE_CODE = edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .replace(/punct/g, PUNCT)
  .regex();

const PUNCTUATION = edit(/^((?![*_])punctSpace)/, 'u')
  .replace(/punctSpace/g, PUNCT_SPACE)
  .regex();

const INLINE = {
  escape: edit(/^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/).sticky(),
  code: edit(/^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/).sticky(),
  br: edit(/^( {2,}|\\)\n(?!\s*$)[ \t]*/).sticky(),
  text: edit(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
    .replace('protocol', CASE_INSENSITIVE_PROTOCOL)
    .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
    .replace('wwwStart', supportsLookbehind ? '(?<![^\\s*_~(])www\\.' : 'www\\.')
    .sticky(),
  autolink: edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
    .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
    .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
    .sticky(),
  tag: edit(
    '^comment'
    + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
    + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>'
    + '|^<\\?[\\s\\S]*?\\?>'
    + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
    + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
    .replace('comment', edit(COMMENT).replace('(?:-->|$)', '-->').regex())
    .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
    .sticky(),
  link: edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
    .replace('label', INLINE_LABEL)
    .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
    .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
    .sticky(),
  reflink: edit(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', INLINE_LABEL)
    .replace('ref', BLOCK_LABEL)
    .sticky(),
  nolink: edit(/^!?\[(ref)\](?:\[\])?/)
    .replace('ref', BLOCK_LABEL)
    .sticky(),
  reflinkSearch: edit('reflink|nolink(?!\\()', 'g')
    .replace('reflink', edit(/^!?\[(label)\]\[(ref)\]/)
      .replace('label', BOUNDED_INLINE_LABEL)
      .replace('ref', BOUNDED_BLOCK_LABEL)
      .regex())
    .replace('nolink', edit(/^!?\[(ref)\](?:\[\])?/)
      .replace('ref', BOUNDED_BLOCK_LABEL)
      .regex())
    .regex(),
  url: edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
    .replace('emailProtocol', EXTENDED_EMAIL_PROTOCOL)
    .replace('protocol', CASE_INSENSITIVE_PROTOCOL)
    .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
    .sticky(),
  backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  blockSkip: BLOCK_SKIP,
  anyPunctuation: ANY_PUNCTUATION,
  anyPunctuationOutsideCode: ANY_PUNCTUATION_OUTSIDE_CODE,
  punctuation: PUNCTUATION,
  emStrongLDelim: EM_STRONG_L_DELIM,
  emStrongRDelimAst: EM_STRONG_R_DELIM_AST,
  emStrongRDelimUnd: EM_STRONG_R_DELIM_UND,
  delLDelim: DEL_L_DELIM,
  delRDelim: DEL_R_DELIM,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape HTML special characters. With encode, every `&` is escaped; without
 * it an `&` that starts a character reference (`&#123;`, `&#xAB;`, `&word;`)
 * is left alone.
 */
function escapeHtmlEntities(html, encode) {
  if (encode) {
    if (O.escapeTest.test(html)) {
      return html.replace(O.escapeReplace, (ch) => ESCAPE_MAP[ch]);
    }
  } else if (O.escapeTestNoEncode.test(html)) {
    return html.replace(O.escapeReplaceNoEncode, (ch) => ESCAPE_MAP[ch]);
  }
  return html;
}

/**
 * Numeric character references outside code stand for the character they
 * name. Zero, out of range, or surrogate values become U+FFFD. A decoded
 * character must not join its neighbours into a new reference, so every `&`
 * that is not already one is escaped here.
 */
function decodeNumericCharacterReferences(text) {
  // The pattern can only match a numeric reference, which starts with
  // '&#'; a run without one skips the regex test.
  if (!text.includes('&#') || !O.numericCharacterReference.test(text)) {
    return text;
  }
  return text.replace(O.numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) {
      return '&amp;';
    }
    const code = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      return '\uFFFD';
    }
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(O.percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}

function splitCells(tableRow, count) {
  // Ensure that every cell-delimiting pipe has a space before it, to tell it
  // apart from an escaped pipe.
  const row = tableRow.replace(O.findPipe, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    if (escaped) {
      return '|';
    }
    return ' |';
  });
  const cells = row.split(O.splitPipe);
  let i = 0;

  // First/last cell in a row cannot be empty if it has no leading/trailing pipe
  if (!cells[0].trim()) {
    cells.shift();
  }
  if (cells.length > 0 && !cells.at(-1)?.trim()) {
    cells.pop();
  }

  if (count) {
    if (cells.length > count) {
      cells.splice(count);
    } else {
      while (cells.length < count) cells.push('');
    }
  }

  for (; i < cells.length; i++) {
    // Leading or trailing whitespace is ignored per the GFM spec
    cells[i] = cells[i].trim().replace(O.slashPipe, '|');
  }
  return cells;
}

/** Remove trailing `c`s (or, with invert, trailing non-`c`s). */
function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) {
    return '';
  }
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) {
      suffLen++;
    } else if (currChar !== c && invert) {
      suffLen++;
    } else {
      break;
    }
  }
  return str.slice(0, l - suffLen);
}

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && O.blankLine.test(lines[end])) {
    end--;
  }
  if (lines.length - end <= 2) {
    // Keep a single trailing blank line
    return str;
  }
  return lines.slice(0, end + 1).join('\n');
}

/**
 * Normalize a link label so definitions and references match. The spec asks
 * for a Unicode case fold; round-tripping through upper case reaches it
 * (`ß` folds to `ss` only via upper case), and the final lower case keeps
 * the folded label lower case.
 */
function normalizeLabel(label) {
  return label.trim().replace(O.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function findClosingBracket(str, b) {
  // An opening bracket on its own is still unbalanced, so both have to be absent
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) {
    return -1;
  }
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') {
      i++;
    } else if (str[i] === b[0]) {
      level++;
    } else if (str[i] === b[1]) {
      level--;
      if (level < 0) {
        return i;
      }
    }
  }
  if (level > 0) {
    return -2;
  }
  return -1;
}

function expandTabs(line, indent = 0) {
  let col = indent;
  let expanded = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else {
      expanded += char;
      col++;
    }
  }
  return expanded;
}

function indentCodeCompensation(raw, text) {
  const matchIndentToCode = raw.match(O.indentCodeCompensation);
  if (matchIndentToCode === null) {
    return text;
  }
  const indentToCode = matchIndentToCode[1];
  return text
    .split('\n')
    .map((node) => {
      const matchIndentInNode = node.match(O.beginningSpace);
      if (matchIndentInNode === null) {
        return node;
      }
      const [indentInNode] = matchIndentInNode;
      // Up to the fence's own indentation is removed from each line, so a line
      // indented less than the fence loses whatever indentation it has.
      return node.slice(Math.min(indentInNode.length, indentToCode.length));
    })
    .join('\n');
}

/**
 * True when a link label's closing bracket sits inside an autolink or tag
 * that the label text itself opens. `absPos` is the index of the link's `[`
 * (or `![`) in `src`; `labelStart` is the label's start relative to it.
 */
function isLabelEndInsideToken(src, label, labelStart, absPos) {
  if (!label.includes('<')) {
    return false;
  }
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = (INLINE.code.lastIndex = i, INLINE.code.exec(label));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') {
      continue;
    }
    const tokenSrc = src.slice(absPos + labelStart + i);
    const token = (INLINE.tag.lastIndex = 0, INLINE.tag.exec(tokenSrc)) || (INLINE.autolink.lastIndex = 0, INLINE.autolink.exec(tokenSrc));
    if (!token) {
      continue;
    }
    if (token[0].length > label.length - i) {
      return true;
    }
    i += token[0].length - 1;
  }
  return false;
}

/**
 * Last indexes of `*` / `_` runs that can close emphasis or strong, and of
 * a `~` run that can close strikethrough, in one scan of `src`. A run can
 * close only when it is not preceded by ASCII whitespace or the start of the
 * string.
 */
function scanLastPossibleClosers(src) {
  const em = { '*': -1, _: -1 };
  let del = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') {
      continue;
    }
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) {
      j++;
    }
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') {
        del = i;
      } else {
        em[ch] = i;
      }
    }
    i = j - 1;
  }
  return { em, del };
}

// ---------------------------------------------------------------------------
// Block tokenizing. Every tokenizer takes (ctx, s, pos) and returns the
// token it matched at pos, or null. The main loop advances by the token's
// raw length, exactly as marked advances by the raw it consumed.
// ---------------------------------------------------------------------------

function lineAt(s, pos) {
  const nl = s.indexOf('\n', pos);
  return nl === -1 ? s.slice(pos) : s.slice(pos, nl);
}

function advanceLine(s, pos) {
  const nl = s.indexOf('\n', pos);
  return nl === -1 ? s.length : nl + 1;
}

/** A sticky copy of a regex: `^` anchors dropped, `y` flag added. */
function stickyOf(re) {
  return new RegExp(re.source.replace(/(^|\|)\^/g, '$1'), re.flags.replace('g', '') + 'y');
}

function tokSpace(ctx, s, pos) {
  const cap = (BLOCK.newline.lastIndex = pos, BLOCK.newline.exec(s));
  if (cap && cap[0].length > 0) {
    return { t: 'space', raw: cap[0] };
  }
  return null;
}

function tokCode(ctx, s, pos) {
  const cap = (BLOCK.code.lastIndex = pos, BLOCK.code.exec(s));
  if (!cap) return null;
  const raw = trimTrailingBlankLines(cap[0]);
  const text = raw.replace(O.codeRemoveIndent, '');
  return { t: 'code', raw, text };
}

function tokFences(ctx, s, pos) {
  const cap = (BLOCK.fences.lastIndex = pos, BLOCK.fences.exec(s));
  if (!cap) return null;
  const raw = cap[0];
  const text = indentCodeCompensation(raw, cap[3] || '');
  return {
    t: 'code',
    raw,
    lang: cap[2] ? cap[2].trim().replace(INLINE.anyPunctuation, '$1') : cap[2],
    text,
  };
}

function tokHeading(ctx, s, pos) {
  const cap = (BLOCK.heading.lastIndex = pos, BLOCK.heading.exec(s));
  if (!cap) return null;
  let text = cap[2].trim();
  // Remove trailing #s; CommonMark requires a space or tab before them.
  if (O.endingHash.test(text)) {
    const trimmed = rtrim(text, '#');
    if (!trimmed || O.endingSpaceTabChar.test(trimmed)) {
      text = trimmed.trim();
    }
  }
  return { t: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[1].length, text };
}

function tokHr(ctx, s, pos) {
  const cap = (BLOCK.hr.lastIndex = pos, BLOCK.hr.exec(s));
  if (!cap) return null;
  return { t: 'hr', raw: rtrim(cap[0], '\n') };
}

function tokBlockquote(ctx, s, pos) {
  const cap = (BLOCKQUOTE_RE.lastIndex = pos, BLOCKQUOTE_RE.exec(s));
  if (!cap) return null;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];

  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      // Get lines up to a continuation
      if (O.blockquoteStart.test(lines[i])) {
        currentLines.push(lines[i]);
        inBlockquote = true;
      } else if (!inBlockquote) {
        currentLines.push(lines[i]);
      } else {
        break;
      }
    }
    lines = lines.slice(i);

    const currentRaw = currentLines.join('\n');
    const currentText = currentRaw
      // A tab after the block quote marker runs to the next tab stop, and the
      // marker only consumes one space of it; the rest is content
      .replace(
        O.blockquoteMarkerWhitespace,
        (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length),
      )
      // Precede setext continuation with 4 spaces so it isn't a setext
      .replace(O.blockquoteSetextReplace, '\n    $1')
      .replace(O.blockquoteSetextReplace2, '');
    raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
    text = text ? `${text}\n${currentText}` : currentText;

    // Parse blockquote lines as top level tokens; merge paragraphs if this
    // is a continuation
    const top = ctx.top;
    ctx.top = true;
    blockTokens(ctx, currentText, tokens, true);
    ctx.top = top;

    // If there is no continuation then we are done
    if (lines.length === 0) {
      break;
    }

    const lastToken = tokens.at(-1);

    if (lastToken?.t === 'code' || lastToken?.t === 'heading' || lastToken?.t === 'hr' || lastToken?.t === 'html' || lastToken?.t === 'table') {
      // Blockquote continuation cannot be preceded by a code block, heading,
      // hr, html block or table
      break;
    } else if (lastToken?.t === 'blockquote') {
      // Include continuation in nested blockquote
      const oldToken = lastToken;
      // The continuation lines belong to the same nesting frame as the nested
      // blockquote, which already had one '>' marker stripped, so strip one
      // marker from them too.
      const continuation = lines.join('\n');
      const newText = oldToken.raw + '\n' + continuation.replace(O.blockquoteSetextReplace2, '');
      const newToken = tokBlockquote(ctx, newText, 0);
      tokens[tokens.length - 1] = newToken;

      // Only include continuation lines the nested blockquote actually
      // consumed. Unconsumed trailing lines must stay out of `raw` so the
      // lexer can still tokenize them.
      const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) {
        raw = `${raw}\n${consumed.join('\n')}`;
      }
      text = text.substring(0, text.length - oldToken.text.length) + newToken.text;

      // A leftover line that starts with '>' still belongs to this
      // blockquote; any other leftover line ends it.
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && O.blockquoteStart.test(lines[0])) {
        continue;
      }
      break;
    } else if (lastToken?.t === 'list') {
      // Include continuation in nested list
      const oldToken = lastToken;
      const newText = oldToken.raw + '\n' + lines.join('\n');
      const newToken = tokList(ctx, newText, 0);
      tokens[tokens.length - 1] = newToken;

      // The list raw has no '>' markers, so it cannot be cut out of `raw`.
      // Count the continuation lines the list took and add those lines instead.
      const consumedCount = newToken.raw.length > oldToken.raw.length
        ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = `${raw}\n${consumed}`;
        text = `${text}\n${consumed}`;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }

  return { t: 'blockquote', raw, tokens, text };
}

function tokList(ctx, s, pos) {
  const cap = (BLOCK.list.lastIndex = pos, BLOCK.list.exec(s));
  if (!cap) return null;
  const listStart = pos;
  let cur = pos;
  const len = s.length;
  let bull = cap[1].trim();
  const isordered = bull.length > 1;

  const list = {
    t: 'list',
    raw: '',
    ordered: isordered,
    start: isordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  };

  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRegex = stickyOf(O.listItemRegex(bull));
  let endsWithBlankLine = false;

  // Get next list item
  while (cur < len) {
    let endEarly = false;
    let itemContents = '';
    const m = (itemRegex.lastIndex = cur, itemRegex.exec(s));
    if (!m) break;
    if ((BLOCK.hr.lastIndex = cur, BLOCK.hr.exec(s))) break; // End list if bullet was actually HR

    const itemStart = cur;
    cur += m[0].length;

    const firstLine = m[2].split('\n', 1)[0];
    const bulletIndent = m[1].length;
    let line = firstLine.replace(O.leadingSpaceTab, (ws) => expandTabs(ws, bulletIndent));
    let nextLine = lineAt(s, cur);
    let blankLine = !line.trim();

    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(O.nonSpaceChar); // Find first non-space char
      indent = indent > 4 ? 1 : indent; // Indented code blocks (> 4 spaces) count as only 1 indent
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }

    if (blankLine && O.blankLine.test(nextLine)) {
      // Items begin with at most one blank line
      cur += nextLine.length + 1;
      endEarly = true;
    }

    if (!endEarly) {
      const nextBulletRegex = O.nextBulletRegex(indent);
      const hrRegex = O.hrRegex(indent);
      const fencesBeginRegex = O.fencesBeginRegex(indent);
      const headingBeginRegex = O.headingBeginRegex(indent);
      const htmlBeginRegex = O.htmlBeginRegex(indent);
      const blockquoteBeginRegex = O.blockquoteBeginRegex(indent);

      // Check if following lines should be included in List Item
      // The item's lines are collected and joined once at the end instead
      // of re-concatenating the growing string on every line.
      const itemParts = [itemContents];
      const beginCap = Math.max(0, Math.min(3, indent - 1));
      while (cur < len) {
        const rawLine = lineAt(s, cur);
        nextLine = rawLine;
        // Re-align to follow commonmark nesting rules. The pattern only
        // touches leading whitespace, so a line without any skips it.
        let nextLineWithoutTabs = rawLine;
        if (rawLine.charCodeAt(0) === 32 || rawLine.charCodeAt(0) === 9) {
          nextLineWithoutTabs = rawLine.replace(O.leadingSpaceTab, (ws) => expandTabs(ws));
        }

        // The six begin-tests all need a block marker after at most
        // `beginCap` leading spaces. A line whose first non-space character
        // cannot start one skips them all.
        let k = 0;
        while (k < rawLine.length && rawLine.charCodeAt(k) === 32) k++;
        const firstCh = rawLine[k];
        if (k <= beginCap && firstCh !== undefined
            && (firstCh === '`' || firstCh === '~' || firstCh === '#' || firstCh === '<'
              || firstCh === '>' || firstCh === '*' || firstCh === '+' || firstCh === '-'
              || (firstCh >= '0' && firstCh <= '9') || firstCh === '_')) {
          // End list item if found code fences
          if (fencesBeginRegex.test(nextLine)) break;
          // End list item if found start of new heading
          if (headingBeginRegex.test(nextLine)) break;
          // End list item if found start of html block
          if (htmlBeginRegex.test(nextLine)) break;
          // End list item if found start of blockquote
          if (blockquoteBeginRegex.test(nextLine)) break;
          // End list item if found start of new bullet
          if (nextBulletRegex.test(nextLine)) break;
          // Horizontal rule found
          if (hrRegex.test(nextLine)) break;
        }

        // Index of the first non-space character of the tab-expanded line
        // (a tab counts as non-space, matching the nonSpaceChar search).
        let fi = 0;
        const nwtLen = nextLineWithoutTabs.length;
        while (fi < nwtLen && nextLineWithoutTabs.charCodeAt(fi) === 32) fi++;
        // A line is blank when it holds only whitespace. The scan above
        // decides the common case; a line that starts (after spaces) with a
        // tab needs its remainder checked too. This is the same test as
        // !nextLine.trim(), without allocating the trimmed string.
        let isBlank = fi >= nwtLen;
        if (!isBlank) {
          const c0 = nextLineWithoutTabs.charCodeAt(fi);
          if (c0 === 9 || c0 === 11 || c0 === 12 || c0 === 13) {
            let b = fi;
            isBlank = true;
            while (b < nwtLen) {
              const d = nextLineWithoutTabs.charCodeAt(b);
              if (d !== 32 && d !== 9 && d !== 11 && d !== 12 && d !== 13) { isBlank = false; break; }
              b++;
            }
          }
        }
        if (fi >= indent || isBlank) {
          // Dedent if possible
          itemParts.push(nextLineWithoutTabs.slice(indent));
        } else {
          // Not enough indentation
          if (blankLine) break;
          // Paragraph continuation unless last line was a different block level element
          if (line.replace(O.tabCharGlobal, '    ').search(O.nonSpaceChar) >= 4) break; // Indented code block
          if (fencesBeginRegex.test(line)) break;
          if (headingBeginRegex.test(line)) break;
          if (htmlBeginRegex.test(line)) break;
          if (hrRegex.test(line)) break;

          // A lazy continuation can look like a setext underline after list
          // indentation is removed. Keep it in the paragraph.
          const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
            && (BLOCK.lheading.lastIndex = 0, BLOCK.lheading.exec(`${line}\n${nextLine}`));
          const continuation = setextContinuation
            ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
            : nextLine;
          itemParts.push(continuation);
        }

        blankLine = isBlank;
        cur = advanceLine(s, cur);
        line = nextLineWithoutTabs.slice(indent);
      }
      itemContents = itemParts.join('\n');
    }

    // The loops above appended a '\n' the source may not have had. It could
    // only land on the item that exhausts src, whose raw is trimmed below.
    const raw = s.slice(itemStart, cur);

    if (!list.loose) {
      // If the previous item ended with a blank line, the list is loose
      if (endsWithBlankLine) {
        list.loose = true;
      } else if (O.doubleBlankLine.test(raw)) {
        endsWithBlankLine = true;
      }
    }

    list.items.push({
      raw,
      task: O.listIsTask.test(itemContents),
      loose: false,
      text: itemContents,
      tokens: [],
    });
  }

  // Do not consume newlines at end of final item
  const lastItem = list.items.at(-1);
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    // Not a list since there were no items
    return null;
  }
  list.raw = s.slice(listStart, cur).trimEnd();

  // Item child tokens handled here at end because we needed to have the final
  // item to trim it first. First pass: tokenize items and finalize list.loose
  // from spacers before placing checkboxes.
  for (const item of list.items) {
    ctx.top = false;
    item.tokens = blockTokens(ctx, item.text, []);

    if (!list.loose) {
      // Check if list should be loose
      const spacers = item.tokens.filter((t) => t.t === 'space');
      const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => O.anyLine.test(t.raw));
      list.loose = hasMultipleLineBreaks;
    }
  }

  // Second pass: place task checkboxes using the final list.loose
  for (const item of list.items) {
    const itemToken = item.tokens[0];
    if (item.task && (itemToken?.t === 'text' || itemToken?.t === 'paragraph')) {
      // Remove checkbox markdown from item tokens
      item.text = item.text.replace(O.listReplaceTask, '');
      itemToken.raw = itemToken.raw.replace(O.listReplaceTask, '');
      itemToken.text = itemToken.text.replace(O.listReplaceTask, '');

      const taskRaw = O.listTaskCheckbox.exec(item.raw);
      if (taskRaw) {
        const checkbox = {
          t: 'checkbox',
          raw: taskRaw[0] + ' ',
          checked: taskRaw[0] !== '[ ]',
        };
        item.checked = checkbox.checked;
        if (list.loose) {
          if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].t)) {
            item.tokens[0].raw = checkbox.raw + item.tokens[0].raw;
            // The checkbox renders from `lead`; the text stays the stripped
            // text, as marked renders the paragraph from its inline tokens
            // (checkbox first, then the stripped text), not from its text.
            item.tokens[0].lead = [checkbox];
          } else {
            item.tokens.unshift({ t: 'paragraph', raw: checkbox.raw, text: '', lead: [checkbox] });
          }
        } else {
          item.tokens.unshift(checkbox);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }

  // Set all items to loose if list is loose
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const token of item.tokens) {
        if (token.t === 'text') {
          token.t = 'paragraph';
        }
      }
    }
  }

  return list;
}

function tokHtml(ctx, s, pos) {
  const cap = (BLOCK.html.lastIndex = pos, BLOCK.html.exec(s));
  if (!cap) return null;
  const raw = trimTrailingBlankLines(cap[0]);
  return {
    t: 'html',
    raw,
    pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
    text: raw,
  };
}

function tokDef(ctx, s, pos) {
  const cap = (BLOCK.def.lastIndex = pos, BLOCK.def.exec(s));
  if (!cap) return null;
  // Outside angle brackets a link destination holds only balanced parentheses
  if (!O.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) {
    return null;
  }
  const tag = normalizeLabel(cap[1]);
  const href = cap[2] ? cap[2].replace(O.hrefBrackets, '$1').replace(INLINE.anyPunctuation, '$1') : '';
  const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(INLINE.anyPunctuation, '$1') : cap[3];
  return { t: 'def', tag, raw: rtrim(cap[0], '\n'), href, title };
}

function tokTable(ctx, s, pos) {
  const cap = (BLOCK.table.lastIndex = pos, BLOCK.table.exec(s));
  if (!cap) return null;
  if (!O.tableDelimiter.test(cap[2])) {
    // Delimiter row must have a pipe (|) or colon (:), otherwise it is a setext heading
    return null;
  }
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(O.tableAlignChars, '').split('|');
  const rows = cap[3]?.trim() ? cap[3].replace(O.tableRowBlankLine, '').split('\n') : [];

  const item = {
    t: 'table',
    raw: rtrim(cap[0], '\n'),
    header: [],
    align: [],
    rows: [],
  };

  if (headers.length !== aligns.length) {
    // Header and align columns must be equal; rows can be different.
    return null;
  }

  for (const align of aligns) {
    if (O.tableAlignRight.test(align)) {
      item.align.push('right');
    } else if (O.tableAlignCenter.test(align)) {
      item.align.push('center');
    } else if (O.tableAlignLeft.test(align)) {
      item.align.push('left');
    } else {
      item.align.push(null);
    }
  }

  for (let i = 0; i < headers.length; i++) {
    item.header.push({ text: headers[i], header: true, align: item.align[i] });
  }

  for (const row of rows) {
    item.rows.push(splitCells(row, item.header.length).map((cell, i) => ({
      text: cell,
      header: false,
      align: item.align[i],
    })));
  }

  return item;
}

/**
 * True when a setext underline (= or -) appears on some line before the next
 * blank line. A setext heading's paragraph text cannot span a blank line,
 * so this is a necessary condition for the lheading rule; it lets the block
 * loop skip the big lheading regex for ordinary paragraphs.
 */
function hasSetextUnderline(s, pos) {
  let i = s.indexOf('\n', pos);
  if (i < 0) return false;
  i++;
  const n = s.length;
  while (i < n) {
    let j = i;
    while (j < n && (s[j] === ' ' || s[j] === '\t')) j++;
    if (j >= n || s[j] === '\n') return false; // blank line: no underline after this
    let k = j, spaces = 0;
    while (k < n && s[k] === ' ' && spaces < 3) { k++; spaces++; }
    if (k < n && (s[k] === '=' || s[k] === '-')) {
      const ch = s[k];
      let m = k;
      while (m < n && s[m] === ch) m++;
      let q = m;
      while (q < n && (s[q] === ' ' || s[q] === '\t')) q++;
      if (q >= n || s[q] === '\n') return true;
    }
    i = s.indexOf('\n', i);
    if (i < 0) return false;
    i++;
  }
  return false;
}

function tokLheading(ctx, s, pos) {
  const cap = (BLOCK.lheading.lastIndex = pos, BLOCK.lheading.exec(s));
  if (!cap) return null;
  const text = cap[1].trim();
  return {
    t: 'heading',
    raw: rtrim(cap[0], '\n'),
    depth: cap[2].charAt(0) === '=' ? 1 : 2,
    text,
  };
}

function tokParagraph(ctx, s, pos) {
  const cap = (BLOCK.paragraph.lastIndex = pos, BLOCK.paragraph.exec(s));
  if (!cap) return null;
  const text = cap[1].charAt(cap[1].length - 1) === '\n'
    ? cap[1].slice(0, -1)
    : cap[1];
  return { t: 'paragraph', raw: cap[0], text };
}

function tokText(ctx, s, pos) {
  const cap = (BLOCK.text.lastIndex = pos, BLOCK.text.exec(s));
  if (!cap) return null;
  return { t: 'text', raw: cap[0], text: cap[0] };
}

/**
 * The block loop: try each block rule in order at the current position,
 * advancing by the matched token's raw length. Merges a following indented
 * code block or link definition into a preceding paragraph or text token,
 * and merges consecutive text tokens, exactly as marked does.
 */
function blockTokens(ctx, s, tokens, lastParagraphClipped = false) {
  let pos = 0;
  const len = s.length;
  let prevRemaining = Infinity;
  while (pos < len) {
    const remaining = len - pos;
    if (remaining >= prevRemaining) {
      throw new Error('Infinite loop on byte: ' + s.charCodeAt(pos));
    }
    prevRemaining = remaining;

    let tok = null;

    // newline
    if ((tok = tokSpace(ctx, s, pos))) {
      pos += tok.raw.length;
      const lastToken = tokens.at(-1);
      if (tok.raw.length === 1 && lastToken !== undefined) {
        // A single \n as a spacer terminates the last line, so move it there
        // so that we don't get unnecessary paragraph tags
        lastToken.raw += '\n';
      } else {
        tokens.push(tok);
      }
      continue;
    }

    // code
    if ((tok = tokCode(ctx, s, pos))) {
      pos += tok.raw.length;
      const lastToken = tokens.at(-1);
      // An indented code block cannot interrupt a paragraph.
      if (lastToken?.t === 'paragraph' || lastToken?.t === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        lastToken.text += '\n' + tok.text;
      } else {
        tokens.push(tok);
      }
      continue;
    }

    // fences
    if ((tok = tokFences(ctx, s, pos))) {
      pos += tok.raw.length;
      tokens.push(tok);
      continue;
    }

    // heading
    if ((tok = tokHeading(ctx, s, pos))) {
      pos += tok.raw.length;
      tokens.push(tok);
      continue;
    }

    // hr
    if ((tok = tokHr(ctx, s, pos))) {
      pos += tok.raw.length;
      tokens.push(tok);
      continue;
    }

    // blockquote
    if ((tok = tokBlockquote(ctx, s, pos))) {
      pos += tok.raw.length;
      tokens.push(tok);
      continue;
    }

    // list
    if ((tok = tokList(ctx, s, pos))) {
      pos += tok.raw.length;
      tokens.push(tok);
      continue;
    }

    // html
    if ((tok = tokHtml(ctx, s, pos))) {
      pos += tok.raw.length;
      tokens.push(tok);
      continue;
    }

    // def
    if ((tok = tokDef(ctx, s, pos))) {
      pos += tok.raw.length;
      const lastToken = tokens.at(-1);
      if (lastToken?.t === 'paragraph' || lastToken?.t === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        lastToken.text += '\n' + tok.raw;
      } else {
        // The first definition of a label wins, but a later one still consumes its text
        if (!Object.hasOwn(ctx.links, tok.tag)) {
          ctx.links[tok.tag] = { href: tok.href, title: tok.title };
        }
        tokens.push(tok);
      }
      continue;
    }

    // table (gfm)
    if ((tok = tokTable(ctx, s, pos))) {
      pos += tok.raw.length;
      tokens.push(tok);
      continue;
    }

    // lheading (a setext underline must appear before the next blank line,
    // so a cheap line scan skips the big regex when there is none)
    if (hasSetextUnderline(s, pos) && (tok = tokLheading(ctx, s, pos))) {
      pos += tok.raw.length;
      tokens.push(tok);
      continue;
    }

    // top-level paragraph
    if (ctx.top && (tok = tokParagraph(ctx, s, pos))) {
      pos += tok.raw.length;
      const lastToken = tokens.at(-1);
      if (lastParagraphClipped && lastToken?.t === 'paragraph') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        lastToken.text += '\n' + tok.text;
      } else {
        tokens.push(tok);
      }
      lastParagraphClipped = false;
      continue;
    }

    // text
    if ((tok = tokText(ctx, s, pos))) {
      pos += tok.raw.length;
      const lastToken = tokens.at(-1);
      if (lastToken?.t === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        lastToken.text += '\n' + tok.text;
      } else {
        tokens.push(tok);
      }
      continue;
    }

    throw new Error('Infinite loop on byte: ' + s.charCodeAt(pos));
  }

  ctx.top = true;
  return tokens;
}

// ---------------------------------------------------------------------------
// Inline rendering. An inline run is rendered straight to a string as it is
// scanned — no inline token tree is built. `textMode` renders the plain text
// of a run (the image alt text); otherwise HTML is rendered. The scanner
// state (inLink, inRawBlock, linkEmitted, linkParenPossible) lives on ctx
// and is shared exactly as marked shares its lexer state.
// ---------------------------------------------------------------------------

/**
 * Does this link text hold a link already? An image does not count: an image
 * may hold a link, a link may not.
 */
function linkInText(ctx, text) {
  if (!text.includes('[')) {
    return false;
  }
  for (const match of text.matchAll(INLINE.blockSkip)) {
    if ((INLINE.link.lastIndex = 0, INLINE.link.exec(match[0])) && text.charAt(match.index - 1) !== '!') {
      return true;
    }
  }
  for (const match of text.matchAll(INLINE.reflinkSearch)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(ctx.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
      continue;
    }
    // A candidate holding a link is not a link either, so it does not count
    if (refStart > 1 && linkInText(ctx, match0.slice(1, refStart - 1))) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Mask links, code, html and escapes so emStrong and del do not see their
 * delimiters inside them. Every replacement keeps the length it replaces,
 * so indexes in the masked source line up with the real source.
 */
function maskSrc(ctx, src) {
  let maskedSrc = src;

  // Mask out reflinks (a run with no link definitions has none to mask)
  if (ctx.linkCount > 0 && src.includes('[')) {
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(ctx.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
        return match0;
      }
      // A candidate whose text already holds a link never becomes a link, so
      // flattening the whole span would hide the emphasis that does still
      // apply inside it. Mask the links it holds instead.
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(ctx, text)) {
          return '[' + text.replace(INLINE.reflinkSearch, maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    maskedSrc = maskedSrc.replace(INLINE.reflinkSearch, maskReflink);
  }

  // Mask out escaped characters. A backslash inside a code span is literal,
  // not an escape, so the backticks inside the span are masked instead.
  // The pattern can only match where a backslash or a backtick appears.
  if (src.includes('\\') || src.includes('`')) {
  maskedSrc = maskedSrc.replace(INLINE.anyPunctuationOutsideCode, (match0, code, punct) => {
    if (punct) {
      return '+'.repeat(match0.length);
    }
    if (code) {
      return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
    }
    return match0;
  });
  }

  // Mask out links, code spans and html. Each match becomes [aaa...a] of the
  // same length (the offset the original leaves for a context group is
  // always zero: the group is empty or absent). The pattern can only match
  // where a '[', a backtick or a '<' appears.
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    maskedSrc = maskedSrc.replace(INLINE.blockSkip, (match0) => '[' + 'a'.repeat(match0.length - 2) + ']');
  }

  return maskedSrc;
}

/**
 * Render a link or image token's inner text and build its HTML. Returns null
 * when a link's text holds another link, so the caller falls through to
 * plain text and the inner link is the one kept.
 */
function renderLinkLike(ctx, pos, cap, href, title, isImage, textMode) {
  const text = cap[1].replace(O.outputLinkReplace, '$1');
  const outerInLink = ctx.inLink;
  const outerLinkEmitted = ctx.linkEmitted;
  const outerInRawBlock = ctx.inRawBlock;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  // An image's text is flattened into an alt attribute, so it is rendered in
  // text mode; a link's text is rendered in the run's own mode.
  const inner = renderInline(ctx, text, isImage ? true : textMode);
  const textHasLink = ctx.linkEmitted;
  ctx.linkEmitted = outerLinkEmitted;
  ctx.inLink = outerInLink;
  const end = pos + cap[0].length;

  if (!isImage) {
    // Links may not contain other links, at any level of nesting.
    if (textHasLink) {
      // These inner tokens are discarded, so undo the raw-block state they
      // opened; leaving it set would suppress escaping for the re-scanned text
      ctx.inRawBlock = outerInRawBlock;
      return null;
    }
    ctx.linkEmitted = true;
  }

  if (textMode) {
    // In text mode a link or image renders as its inner text alone.
    return { html: inner, end };
  }

  if (isImage) {
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) {
      return { html: escapeHtmlEntities(inner), end };
    }
    let out = `<img src="${escapeHtmlEntities(cleanHref)}" alt="${escapeHtmlEntities(inner)}"`;
    if (title) {
      out += ` title="${escapeHtmlEntities(title)}"`;
    }
    out += '>';
    return { html: out, end };
  }

  const cleanHref = cleanUrl(href);
  if (cleanHref === null) {
    return { html: inner, end };
  }
  let out = '<a href="' + escapeHtmlEntities(cleanHref, false) + '"';
  if (title) {
    out += ' title="' + escapeHtmlEntities(title) + '"';
  }
  out += '>' + inner + '</a>';
  return { html: out, end };
}

function tryInlineLink(ctx, src, pos, textMode) {
  // The link regex backtracks quadratically over unterminated-link inputs;
  // without a ')' ahead it cannot match, so bail out before running it.
  if (ctx.linkParenPossible === false) {
    return null;
  }
  const cap = (INLINE.link.lastIndex = pos, INLINE.link.exec(src));
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], labelStart, pos)) {
    return null;
  }
  const trimmedUrl = cap[2].trim();
  if (O.startAngleBracket.test(trimmedUrl)) {
    // CommonMark requires matching angle brackets
    if (!O.endAngleBracket.test(trimmedUrl)) {
      return null;
    }
    // Ending angle bracket cannot be escaped
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) {
      return null;
    }
  } else {
    // Find closing parenthesis
    const lastParenIndex = findClosingBracket(cap[2], '()');
    if (lastParenIndex === -2) {
      // More open parens than closed
      return null;
    }
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  // The ')' that ends the match is the link closer only when it is not
  // escaped. `[foo](/url\)` has no closer; that paren is destination text.
  const unescaped = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) {
    return null;
  }
  let href = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (O.startAngleBracket.test(href)) {
    href = href.slice(1, -1);
  }
  return renderLinkLike(ctx, pos, cap,
    href ? href.replace(INLINE.anyPunctuation, '$1') : href,
    title ? title.replace(INLINE.anyPunctuation, '$1') : title,
    cap[0].charAt(0) === '!', textMode);
}

function tryReflink(ctx, src, pos, textMode) {
  const cap = (INLINE.reflink.lastIndex = pos, INLINE.reflink.exec(src)) || (INLINE.nolink.lastIndex = pos, INLINE.nolink.exec(src));
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], labelStart, pos)) {
    return null;
  }
  const link = ctx.links[normalizeLabel(cap[2] || cap[1])];
  if (!link) {
    // Not a link: emit just the first character as text
    const ch = cap[0].charAt(0);
    return { html: textMode ? ch : escapeHtmlEntities(ch), end: pos + 1 };
  }
  return renderLinkLike(ctx, pos, cap, link.href, link.title, cap[0].charAt(0) === '!', textMode);
}

function tryEmStrong(ctx, src, pos, maskedSrc, closers, prevChar, textMode) {
  const match = (INLINE.emStrongLDelim.lastIndex = pos, INLINE.emStrongLDelim.exec(src));
  if (!match) return null;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return null;

  const delimChar = match[0][0];
  // A mid-run opener (for example the second star of an unmatched `**`) must
  // only pair with a delimiter that can only close, otherwise it steals the
  // opener of a later span.
  const midRun = prevChar === delimChar;

  // The start of this delimiter run may already be behind pos, either taken
  // as text after the whole run failed to match or used to close an earlier
  // span. Flanking and rules 9-10 are about the whole run, so find its start.
  const srcStart = pos;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) {
    runStart--;
  }
  const runPrevChar = [...maskedSrc.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  // The other delimiter character counts as punctuation here (`_**a*`)
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!(INLINE.punctuation.lastIndex = 0, INLINE.punctuation.exec(runPrevChar));
  if (runStart < srcStart) {
    prevChar = runPrevChar;
  }
  const prevPunct = runStart < srcStart ? runPrevPunct : !!(INLINE.punctuation.lastIndex = 0, INLINE.punctuation.exec(prevChar));

  // _ can't be between two alphanumerics
  if (match[4] && prevChar.match(O.unicodeAlphaNumeric)) return null;

  const nextChar = match[1] || match[3] || '';

  if (!nextChar || !prevChar || prevPunct) {
    // Unicode regex counts emoji as 1 char; spread into array for proper count
    const lLength = [...match[0]].length - 1;
    let rDelim;
    let rLength;
    let delimTotal = lLength;
    let midDelimTotal = 0;

    // Rules 9-10 count the whole run, and also apply when the opener could
    // close as well (`a*b**`, where `*` is both left- and right-flanking).
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return null;
    const endReg = delimChar === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
    const lastPossible = closers.em[delimChar];
    const windowStart = pos + lLength;
    if (lastPossible < windowStart) return null;
    // Clip maskedSrc to the same section of string as the remaining source
    const window = maskedSrc.slice(windowStart);
    const lastPossibleInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;

    let m;
    while ((m = endReg.exec(window)) !== null) {
      if (m.index > lastPossibleInWindow) break;
      rDelim = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!rDelim) continue; // Skip single * in __abc*abc__

      rLength = [...rDelim].length;

      if (m[3] || m[4]) { // Found another Left Delim
        delimTotal += rLength;
        continue;
      } else if (m[5] || m[6] || openerCanClose) { // Either Left or Right Delim
        if (midRun && (m[5] || m[6])) {
          // A mid-run opener cannot close against an ambiguous delimiter that
          // can also open; that delimiter opens its own emphasis span instead.
          break;
        }
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue; // CommonMark Emphasis Rules 9-10
        }
      }

      delimTotal -= rLength;
      if (delimTotal > 0) continue; // Haven't found enough closing delimiters

      // Remove extra characters. *a*** -> *a*
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      // Char length can be >1 for unicode characters
      const lastCharLength = [...m[0]][0].length;
      const raw = src.slice(pos, pos + lLength + m.index + lastCharLength + rLength);

      // Create `em` if smallest delimiter has odd char count. *a***
      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        const inner = renderInline(ctx, text, textMode);
        return { html: textMode ? inner : `<em>${inner}</em>`, end: pos + raw.length };
      }

      // Create 'strong' if smallest delimiter has even char count. **a***
      const text = raw.slice(2, -2);
      const inner = renderInline(ctx, text, textMode);
      return { html: textMode ? inner : `<strong>${inner}</strong>`, end: pos + raw.length };
    }
  }
  return null;
}

function tryDel(ctx, src, pos, maskedSrc, closers, prevChar, textMode) {
  const match = (INLINE.delLDelim.lastIndex = pos, INLINE.delLDelim.exec(src));
  if (!match) return null;

  const nextChar = match[1] || '';

  if (!nextChar || !prevChar || (INLINE.punctuation.lastIndex = 0, INLINE.punctuation.exec(prevChar))) {
    const lLength = [...match[0]].length - 1;
    let rDelim;
    let rLength;
    let delimTotal = lLength;

    const lastPossible = closers.del;
    const windowStart = pos + lLength;
    if (lastPossible < windowStart) return null;
    const window = maskedSrc.slice(windowStart);
    const lastPossibleInWindow = lastPossible - windowStart;
    const endReg = INLINE.delRDelim;
    endReg.lastIndex = 0;

    let m;
    while ((m = endReg.exec(window)) !== null) {
      if (m.index > lastPossibleInWindow) break;
      rDelim = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!rDelim) continue;

      rLength = [...rDelim].length;
      if (rLength !== lLength) continue;

      if (m[3] || m[4]) { // Found another Left Delim
        delimTotal += rLength;
        continue;
      }

      delimTotal -= rLength;
      if (delimTotal > 0) continue; // Haven't found enough closing delimiters

      // Remove extra characters
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...m[0]][0].length;
      const raw = src.slice(pos, pos + lLength + m.index + lastCharLength + rLength);

      // Only single ~ or double ~~ supported
      const text = raw.slice(lLength, -lLength);
      const inner = renderInline(ctx, text, textMode);
      return { html: textMode ? inner : `<del>${inner}</del>`, end: pos + raw.length };
    }
  }
  return null;
}

/** Build the HTML of an autolink (`<scheme:...>` or `<email>`) or an extended autolink. */
function autolinkHtml(text, href, textMode) {
  if (textMode) {
    return text;
  }
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) {
    return escapeHtmlEntities(text, true);
  }
  return '<a href="' + escapeHtmlEntities(cleanHref, true) + '">' + escapeHtmlEntities(text, true) + '</a>';
}

/** Fast pre-filter for the GFM extended-autolink rule: it can only match a
 * www./protocol:// start, a mailto:/xmpp: start, or an email address. */
function maybeUrl(src, pos) {
  const head = src.slice(pos, pos + 8).toLowerCase();
  if (head.startsWith('www.') || head.startsWith('http://') || head.startsWith('https://')
    || head.startsWith('ftp://') || head.startsWith('mailto:') || head.startsWith('xmpp:')) {
    return true;
  }
  // Email: a run of [A-Za-z0-9._+-] holding '@'
  const len = src.length;
  let i = pos;
  while (i < len) {
    const c = src[i];
    if (c === '@') return true;
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
      || c === '.' || c === '_' || c === '+' || c === '-') {
      i++;
      continue;
    }
    return false;
  }
  return false;
}

/** Fast pre-filter for the GFM extended-autolink rule: it can only match a
 * www./protocol:// start, a mailto:/xmpp: start, or an email address. */
function renderInline(ctx, src, textMode) {
  // One paren scan per run, shared with the link rule: without a ')' ahead
  // the link regex cannot match, and skipping it avoids its quadratic
  // backtracking over unterminated-link inputs.
  const prevLinkParenPossible = ctx.linkParenPossible;
  ctx.linkParenPossible = prevLinkParenPossible && src.includes(')');
  try {
  // The masked source is only read by emStrong and del, which need a *, _ or
  // ~ to start. Skip building it for a run without one. When the run holds
  // nothing the mask would change (no link, code span, escape or tag), the
  // mask is the identity, so skip the passes too.
  const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
  let maskedSrc = src;
  let closers = null;
  if (needsMask) {
    if (src.includes('[') || src.includes('`') || src.includes('\\') || src.includes('<')) {
      maskedSrc = maskSrc(ctx, src);
    }
    closers = scanLastPossibleClosers(maskedSrc);
  }

  let out = '';
  let pos = 0;
  const len = src.length;
  let keepPrevChar = false;
  let prevChar = '';
  let prevRemaining = Infinity;
  while (pos < len) {
    const remaining = len - pos;
    if (remaining >= prevRemaining) {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    }
    prevRemaining = remaining;

    if (!keepPrevChar) {
      prevChar = '';
    }
    keepPrevChar = false;

    // Dispatch on the first character: at any position only the rules that
    // can start with that character are tried, in marked's order, before
    // falling through to plain text.
    const ch = src[pos];
    let cap;
    let res;

    if (ch === '\\') {
      // escape
      cap = (INLINE.escape.lastIndex = pos, INLINE.escape.exec(src));
      if (cap) {
        out += textMode ? cap[1] : escapeHtmlEntities(cap[1]);
        pos += cap[0].length;
        continue;
      }
      // br
      cap = (INLINE.br.lastIndex = pos, INLINE.br.exec(src));
      if (cap) {
        if (!textMode) out += '<br>';
        pos += cap[0].length;
        continue;
      }
    } else if (ch === '<') {
      // tag
      cap = (INLINE.tag.lastIndex = pos, INLINE.tag.exec(src));
      if (cap) {
        if (!ctx.inLink && O.startATag.test(cap[0])) {
          ctx.inLink = true;
        } else if (ctx.inLink && O.endATag.test(cap[0])) {
          ctx.inLink = false;
        }
        if (!ctx.inRawBlock && O.startPreScriptTag.test(cap[0])) {
          ctx.inRawBlock = true;
        } else if (ctx.inRawBlock && O.endPreScriptTag.test(cap[0])) {
          ctx.inRawBlock = false;
        }
        out += cap[0];
        pos += cap[0].length;
        continue;
      }
      // autolink
      cap = (INLINE.autolink.lastIndex = pos, INLINE.autolink.exec(src));
      if (cap) {
        let text;
        let href;
        if (cap[2] === '@') {
          text = cap[1];
          href = 'mailto:' + text;
        } else {
          text = cap[1];
          href = text;
        }
        out += autolinkHtml(text, href, textMode);
        pos += cap[0].length;
        continue;
      }
    } else if (ch === '[' || (ch === '!' && src[pos + 1] === '[')) {
      // link
      res = tryInlineLink(ctx, src, pos, textMode);
      if (res) {
        out += res.html;
        pos = res.end;
        continue;
      }
      // reflink, nolink
      res = tryReflink(ctx, src, pos, textMode);
      if (res) {
        out += res.html;
        pos = res.end;
        continue;
      }
    } else if (ch === '*' || ch === '_') {
      // em & strong
      res = tryEmStrong(ctx, src, pos, maskedSrc, closers, prevChar, textMode);
      if (res) {
        out += res.html;
        pos = res.end;
        continue;
      }
    } else if (ch === '`') {
      // code
      cap = (INLINE.code.lastIndex = pos, INLINE.code.exec(src));
      if (cap) {
        let text = cap[2].replace(O.newLineCharGlobal, ' ');
        const hasNonSpaceChars = O.nonSpaceChar.test(text);
        const hasSpaceCharsOnBothEnds = O.startingSpaceChar.test(text) && O.endingSpaceChar.test(text);
        if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) {
          text = text.substring(1, text.length - 1);
        }
        out += textMode ? text : `<code>${escapeHtmlEntities(text, true)}</code>`;
        pos += cap[0].length;
        continue;
      }
    } else if (ch === '~') {
      // del (gfm)
      res = tryDel(ctx, src, pos, maskedSrc, closers, prevChar, textMode);
      if (res) {
        out += res.html;
        pos = res.end;
        continue;
      }
    } else if (ch === ' ') {
      // br
      cap = (INLINE.br.lastIndex = pos, INLINE.br.exec(src));
      if (cap) {
        if (!textMode) out += '<br>';
        pos += cap[0].length;
        continue;
      }
    } else if (!ctx.inLink && maybeUrl(src, pos)) {
      // url (gfm)
      cap = (INLINE.url.lastIndex = pos, INLINE.url.exec(src));
      if (cap) {
        let text;
        let href;
        if (cap[2] === '@') {
          text = cap[0];
          href = 'mailto:' + text;
        } else {
          // Do extended autolink path validation
          let prevCapZero;
          do {
            prevCapZero = cap[0];
            cap[0] = INLINE.backpedal.exec(cap[0])?.[0] ?? '';
          } while (prevCapZero !== cap[0]);
          text = cap[0];
          if (cap[1] === 'www.') {
            href = 'http://' + cap[0];
          } else {
            href = cap[0];
          }
        }
        out += autolinkHtml(text, href, textMode);
        pos += cap[0].length;
        continue;
      }
    }

    // text
    cap = (INLINE.text.lastIndex = pos, INLINE.text.exec(src));
    if (cap) {
      const escaped = ctx.inRawBlock;
      // Raw HTML keeps whatever it was written with; everywhere else a
      // numeric character reference stands for the character itself
      const text = escaped ? cap[0] : decodeNumericCharacterReferences(cap[0]);
      out += textMode ? text : (escaped ? text : escapeHtmlEntities(text));
      // Track prevChar before a string of ____ started
      if (cap[0].slice(-1) !== '_') {
        prevChar = cap[0].slice(-1);
      }
      keepPrevChar = true;
      pos += cap[0].length;
      continue;
    }

    throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
  }

    return out;
  } finally {
    // A nested run (e.g. a link label) anchored on its own substring;
    // restore the outer run's flag for the rest of its loop.
    ctx.linkParenPossible = prevLinkParenPossible;
  }
}

// ---------------------------------------------------------------------------
// Block rendering + entry point
// ---------------------------------------------------------------------------

function checkboxHtml(token) {
  return '<input '
    + (token.checked ? 'checked="" ' : '')
    + 'disabled="" type="checkbox"> ';
}

function renderBlocks(ctx, tokens, out) {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.t) {
      case 'space': {
        break;
      }
      case 'hr': {
        out.push('<hr>\n');
        break;
      }
      case 'heading': {
        // An inline <pre>, <code>, <kbd> or <script> left open ends with the
        // block holding it; carried over, it would stop every later block's
        // text from being escaped
        ctx.inRawBlock = false;
        out.push(`<h${token.depth}>${renderInline(ctx, token.text, false)}</h${token.depth}>\n`);
        break;
      }
      case 'code': {
        const langString = (token.lang || '').match(O.notSpaceStart)?.[0];
        // An empty code block has no content, so it must not gain a newline.
        const code = token.text ? token.text.replace(O.endingNewline, '') + '\n' : '';
        if (!langString) {
          out.push('<pre><code>' + escapeHtmlEntities(code, true) + '</code></pre>\n');
        } else {
          out.push('<pre><code class="language-'
            + escapeHtmlEntities(langString)
            + '">'
            + escapeHtmlEntities(code, true)
            + '</code></pre>\n');
        }
        break;
      }
      case 'table': {
        let header = '';
        let cell = '';
        for (let j = 0; j < token.header.length; j++) {
          const c = token.header[j];
          ctx.inRawBlock = false;
          const content = renderInline(ctx, c.text, false);
          const tag = c.align ? `<th align="${c.align}">` : '<th>';
          cell += tag + content + '</th>\n';
        }
        header += `<tr>\n${cell}</tr>\n`;

        let body = '';
        for (let j = 0; j < token.rows.length; j++) {
          const row = token.rows[j];
          cell = '';
          for (let k = 0; k < row.length; k++) {
            const c = row[k];
            ctx.inRawBlock = false;
            const content = renderInline(ctx, c.text, false);
            const tag = c.align ? `<td align="${c.align}">` : '<td>';
            cell += tag + content + '</td>\n';
          }
          body += `<tr>\n${cell}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;

        out.push('<table>\n'
          + '<thead>\n'
          + header
          + '</thead>\n'
          + body
          + '</table>\n');
        break;
      }
      case 'blockquote': {
        out.push('<blockquote>\n');
        renderBlocks(ctx, token.tokens, out);
        out.push('</blockquote>\n');
        break;
      }
      case 'list': {
        const type = token.ordered ? 'ol' : 'ul';
        const startAttr = (token.ordered && token.start !== 1) ? (' start="' + token.start + '"') : '';
        out.push('<' + type + startAttr + '>\n');
        for (let j = 0; j < token.items.length; j++) {
          out.push('<li>');
          renderBlocks(ctx, token.items[j].tokens, out);
          out.push('</li>\n');
        }
        out.push('</' + type + '>\n');
        break;
      }
      case 'checkbox': {
        out.push(checkboxHtml(token));
        break;
      }
      case 'html': {
        out.push(token.text);
        break;
      }
      case 'def': {
        break;
      }
      case 'paragraph': {
        ctx.inRawBlock = false;
        out.push('<p>');
        if (token.lead) {
          for (let j = 0; j < token.lead.length; j++) {
            out.push(checkboxHtml(token.lead[j]));
          }
        }
        out.push(renderInline(ctx, token.text, false));
        out.push('</p>\n');
        break;
      }
      case 'text': {
        ctx.inRawBlock = false;
        if (token.lead) {
          for (let j = 0; j < token.lead.length; j++) {
            out.push(checkboxHtml(token.lead[j]));
          }
        }
        out.push(renderInline(ctx, token.text, false));
        break;
      }
      default: {
        throw new Error('Token with "' + token.t + '" type was not found.');
      }
    }
  }
}

/**
 * The HTML marked 18.1.3 renders for `markdown`, with marked's defaults.
 * Stateless: every call builds its own links and scanner state, keeps
 * nothing from an earlier call, and writes nothing anywhere.
 */
export function parse(markdown) {
  const src = markdown.includes('\r') ? markdown.replace(O.carriageReturn, '\n') : markdown;
  const ctx = {
    links: Object.create(null),
    top: true,
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
  };
  const tokens = blockTokens(ctx, src, []);
  ctx.linkCount = Object.keys(ctx.links).length;
  const out = [];
  renderBlocks(ctx, tokens, out);
  return out.join('');
}
