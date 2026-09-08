// A YAML SUBSET parser for front matter. Zero dependencies is a hard rule for this plugin — a tool
// that spawns agents with permission prompts disabled should be auditable in one sitting — and the
// only YAML it ever reads is the front matter of its own playbooks and tracker adapters.
//
// Supported: block mappings and sequences by indentation; a mapping that starts on a `- ` line;
// double- and single-quoted scalars; unquoted scalars with trailing `# comments` stripped;
// `true/false/null` and numbers; block scalars (`|` literal, `>` folded); single-line flow sequences
// `[a, "b"]` and flow mappings `{k: v, k2: "v2"}`. Anchors, tags, multi-document streams and
// multi-line flow collections are NOT supported — a front matter that needs them is a front matter
// that should be simplified.
//
// Errors carry the 1-based line number, because "unexpected token" three frames from a 700-line
// adapter is not something a contributor can act on.

export function parseYaml(text) {
  const raw = String(text).replace(/\r\n?/g, '\n').split('\n')
  const lines = raw.map((s, i) => ({ n: i + 1, raw: s, indent: s.search(/\S|$/), text: s.trim() }))
  const p = new Parser(lines)
  const v = p.parseBlock(0, -1)
  const rest = p.skipBlank()
  if (rest < lines.length) throw p.err(rest, 'unexpected content after the document')
  return v === undefined ? null : v
}

/** Extract `---\n…\n---` front matter from a markdown file. Returns {data, body, raw}. */
export function parseFrontMatter(markdown) {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(String(markdown))
  if (!m) return { data: null, body: String(markdown), raw: null }
  return { data: parseYaml(m[1]), body: String(markdown).slice(m[0].length), raw: m[1] }
}

class Parser {
  constructor(lines) {
    this.lines = lines
  }

  err(i, msg) {
    const n = this.lines[i] ? this.lines[i].n : this.lines.length
    return new Error(`yaml: line ${n}: ${msg}`)
  }

  isBlank(i) {
    const l = this.lines[i]
    return !l || l.text === '' || l.text.startsWith('#')
  }

  skipBlank(i = this.pos ?? 0) {
    while (i < this.lines.length && this.isBlank(i)) i++
    return i
  }

  /** Parse the block starting at the first non-blank line at/after `start` whose indent > parentIndent. */
  parseBlock(start, parentIndent) {
    const i = this.skipBlank(start)
    this.pos = i
    if (i >= this.lines.length) return undefined
    const l = this.lines[i]
    if (l.indent <= parentIndent) return undefined
    if (l.text.startsWith('- ') || l.text === '-') return this.parseSequence(i, l.indent)
    if (keyOf(l.text)) return this.parseMapping(i, l.indent)
    // a bare scalar block
    this.pos = i + 1
    return scalar(l.text, this, i)
  }

  parseMapping(start, indent) {
    const out = {}
    let i = start
    while (true) {
      i = this.skipBlank(i)
      if (i >= this.lines.length) break
      const l = this.lines[i]
      if (l.indent < indent) break
      if (l.indent > indent) throw this.err(i, `unexpected indentation (expected ${indent} spaces)`)
      const k = keyOf(l.text)
      if (!k) throw this.err(i, `expected "key: value", got "${l.text}"`)
      const { key, rest } = k
      i++
      if (rest === '' ) {
        // nested block or null
        const nested = this.parseBlock(i, indent)
        out[key] = nested === undefined ? null : nested
        i = this.pos
      } else if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
        const { value, next } = this.blockScalar(i, indent, rest)
        out[key] = value
        i = next
      } else {
        out[key] = scalar(rest, this, i - 1)
        this.pos = i
      }
    }
    this.pos = i
    return out
  }

  parseSequence(start, indent) {
    const out = []
    let i = start
    while (true) {
      i = this.skipBlank(i)
      if (i >= this.lines.length) break
      const l = this.lines[i]
      if (l.indent < indent) break
      if (l.indent > indent) throw this.err(i, `unexpected indentation in sequence (expected ${indent} spaces)`)
      if (!(l.text.startsWith('- ') || l.text === '-')) break
      const rest = l.text === '-' ? '' : l.text.slice(2).trim()
      if (rest === '') {
        const nested = this.parseBlock(i + 1, indent)
        out.push(nested === undefined ? null : nested)
        i = this.pos
        continue
      }
      const k = keyOf(rest)
      if (k && !isQuoted(rest) && !rest.startsWith('[') && !rest.startsWith('{')) {
        // a mapping whose first key sits on the dash line: treat it as a mapping at indent+2 by
        // rewriting this line in place, then parsing from here.
        const itemIndent = indent + 2
        const saved = this.lines[i]
        this.lines[i] = { ...saved, indent: itemIndent, text: rest, raw: ' '.repeat(itemIndent) + rest }
        const m = this.parseMapping(i, itemIndent)
        this.lines[i] = saved
        out.push(m)
        i = this.pos
        continue
      }
      out.push(scalar(rest, this, i))
      i++
    }
    this.pos = i
    return out
  }

  blockScalar(start, parentIndent, marker) {
    const keep = marker.endsWith('-') ? 'strip' : 'clip'
    const folded = marker.startsWith('>')
    let i = start
    const body = []
    let blockIndent = null
    while (i < this.lines.length) {
      const l = this.lines[i]
      if (l.text === '' && l.raw.trim() === '') { body.push(''); i++; continue }
      if (l.indent <= parentIndent) break
      if (blockIndent === null) blockIndent = l.indent
      if (l.indent < blockIndent) break
      body.push(l.raw.slice(blockIndent))
      i++
    }
    // trailing blank lines: clip keeps one newline, strip keeps none
    while (body.length && body[body.length - 1] === '') body.pop()
    let value = folded ? foldLines(body) : body.join('\n')
    if (keep === 'clip') value += '\n'
    this.pos = i
    return { value, next: i }
  }
}

function foldLines(lines) {
  let out = ''
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l === '') { out += '\n'; continue }
    if (out && !out.endsWith('\n')) out += ' '
    out += l
  }
  return out
}

/** `key: rest` → {key, rest}, honouring quoted keys and ignoring `:` inside quotes/brackets. */
function keyOf(text) {
  if (text.startsWith('- ') || text === '-') return null
  let q = null
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) { if (ch === q) q = null; continue }
    if (ch === '"' || ch === "'") { q = ch; continue }
    if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') depth--
    else if (ch === ':' && depth === 0 && (i === text.length - 1 || /\s/.test(text[i + 1]))) {
      const key = unquote(text.slice(0, i).trim())
      if (!key) return null
      return { key, rest: text.slice(i + 1).trim() }
    }
  }
  return null
}

const isQuoted = s => /^["']/.test(s)

function unquote(s) {
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) return JSON.parse(s)
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'")
  return s
}

/** Parse a scalar or a single-line flow collection. */
function scalar(text, p, i) {
  let s = text
  if (s.startsWith('"')) {
    const end = closingQuote(s, '"')
    if (end < 0) throw p.err(i, 'unterminated double-quoted string')
    try { return JSON.parse(s.slice(0, end + 1)) } catch { throw p.err(i, 'bad escape in double-quoted string') }
  }
  if (s.startsWith("'")) {
    const end = closingQuote(s, "'")
    if (end < 0) throw p.err(i, 'unterminated single-quoted string')
    return s.slice(1, end).replace(/''/g, "'")
  }
  if (s.startsWith('[')) return flowSeq(s, p, i)
  if (s.startsWith('{')) return flowMap(s, p, i)
  s = stripComment(s)
  if (s === '' || s === '~' || s === 'null') return null
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(s)) return Number(s)
  return s
}

function closingQuote(s, q) {
  for (let i = 1; i < s.length; i++) {
    if (q === '"' && s[i] === '\\') { i++; continue }
    if (s[i] === q) {
      if (q === "'" && s[i + 1] === "'") { i++; continue }
      return i
    }
  }
  return -1
}

function stripComment(s) {
  const m = /^(.*?)(?:\s+#.*)?$/.exec(s)
  return (m ? m[1] : s).trim()
}

function splitTop(inner, p, i) {
  const parts = []
  let cur = ''
  let q = null
  let depth = 0
  for (const ch of inner) {
    if (q) { cur += ch; if (ch === q) q = null; continue }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue }
    if (ch === '[' || ch === '{') depth++
    if (ch === ']' || ch === '}') depth--
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  if (q) throw p.err(i, 'unterminated quote in flow collection')
  if (cur.trim() !== '') parts.push(cur.trim())
  return parts
}

function flowSeq(s, p, i) {
  const end = matching(s, '[', ']')
  if (end < 0) throw p.err(i, 'unterminated flow sequence')
  const inner = s.slice(1, end)
  return splitTop(inner, p, i).map(part => scalar(part, p, i))
}

function flowMap(s, p, i) {
  const end = matching(s, '{', '}')
  if (end < 0) throw p.err(i, 'unterminated flow mapping')
  const out = {}
  for (const part of splitTop(s.slice(1, end), p, i)) {
    const k = keyOf(part)
    if (!k) throw p.err(i, `expected "key: value" in flow mapping, got "${part}"`)
    out[k.key] = k.rest === '' ? null : scalar(k.rest, p, i)
  }
  return out
}

function matching(s, open, close) {
  let depth = 0
  let q = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (q) { if (ch === q) q = null; continue }
    if (ch === '"' || ch === "'") { q = ch; continue }
    if (ch === open) depth++
    else if (ch === close) { depth--; if (depth === 0) return i }
  }
  return -1
}
