// Safe TSV/ledger helpers. Every rule here is a bug that happened:
//   * a writer that omits the trailing newline makes `wc -l` report N-1 rows;
//   * an append that goes through a shell pipeline with empty input is a silent no-op;
//   * extracting ids by regex over the WHOLE file counts cross-references inside other columns as
//     coverage — always extract by FIELD.

import fs from 'node:fs'

/** Parse TSV text into rows of string fields. Blank lines are skipped; CRLF tolerated. */
export function parseTsv(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter(l => l.length > 0)
    .map(l => l.split('\t'))
}

/** Render one row; tabs and newlines inside a field are replaced (a field can never break the format). */
export function formatRow(fields) {
  return fields.map(f => String(f ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t') + '\n'
}

/** Append exactly one row, with its trailing newline, synchronously. Never a pipeline. */
export function appendRow(file, fields) {
  const line = formatRow(fields)
  if (line.trim() === '') throw new Error('appendRow: refusing to append an empty row')
  fs.appendFileSync(file, line)
  return line
}

/** Write a whole file of rows (used for write-once files like a worklist). */
export function writeRows(file, rows) {
  fs.writeFileSync(file, rows.map(formatRow).join(''))
}

/** Read rows from a file; [] when the file is absent. */
export function readRows(file) {
  try {
    return parseTsv(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
}

/** Values of column `col` (0-based) — extraction by field, never by regex over the file. */
export function column(rows, col) {
  return rows.map(r => r[col] ?? '')
}

/** Distinct values of a column, in first-seen order. */
export function distinct(values) {
  return [...new Set(values)]
}

/** Count rows the way a careful `wc -l` would: lines, not newline characters. */
export function countRows(text) {
  return parseTsv(text).length
}
