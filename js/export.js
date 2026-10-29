// Markdown builders for everything Lipat keeps. Used for Google Drive files and for downloads.
export const REACTIONS = [
  { e: '💡', label: 'Aha', slug: 'aha' },
  { e: '❤️', label: 'Love', slug: 'love' },
  { e: '🤔', label: 'Hmm', slug: 'hmm' },
  { e: '😮', label: 'Whoa', slug: 'whoa' },
  { e: '😤', label: 'Nope', slug: 'nope' },
];
const LABEL = Object.fromEntries(REACTIONS.map(r => [r.e, r.label]));

export const safeName = (s) => String(s || 'Untitled').replace(/[\\/:*?"<>|#%]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Untitled';
const fmtDate = (ts) => new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const secIndex = (sid) => Number(String(sid || 's0').slice(1)) || 0;
const orderKey = (m) => secIndex(m.sectionId) * 1e7 + (m.type === 'bookmark' ? (m.blockIndex || 0) * 1e3 : (m.start || 0));
const sortMarks = (ms) => ms.slice().sort((a, b) => orderKey(a) - orderKey(b));
const quote = (t) => String(t || '').trim().split(/\n+/).map(l => '> ' + l).join('\n');
const tag = (m) => m.type === 'bookmark' ? '🔖 Bookmark' : m.emoji ? `${m.emoji} ${LABEL[m.emoji] || ''}`.trim() : '✎ Note';
const where = (m) => m.page ? `p. ${m.page}` : '';

function counts(marks) {
  const c = { total: marks.length, bookmarks: marks.filter(m => m.type === 'bookmark').length, notes: marks.filter(m => m.note).length };
  for (const r of REACTIONS) c[r.e] = marks.filter(m => m.emoji === r.e).length;
  return c;
}
function summaryLine(marks) {
  const c = counts(marks);
  const parts = REACTIONS.filter(r => c[r.e]).map(r => `${r.e} ${c[r.e]}`);
  if (c.bookmarks) parts.push(`🔖 ${c.bookmarks}`);
  return `${c.total} mark${c.total === 1 ? '' : 's'}${parts.length ? ' · ' + parts.join(' · ') : ''}${c.notes ? ` · ${c.notes} with notes` : ''}`;
}
function markBlock(m, { withBook = null } = {}) {
  const meta = [where(m), fmtDate(m.createdAt)].filter(Boolean).join(' · ');
  let s = `**${tag(m)}**${withBook ? ` — *${withBook}*` : ''}${meta ? `  \n<sub>${meta}</sub>` : ''}\n\n${quote(m.text)}\n`;
  if (m.note) s += `\n${m.note.trim().replace(/\n/g, '  \n')}\n`;
  return s + '\n';
}

// One file per book: marks grouped by chapter in reading order.
export function bookMarkdown(book, marks, sectionTitles = {}) {
  const ms = sortMarks(marks);
  const head = [book.author, (book.format || '').toUpperCase(), summaryLine(ms)].filter(Boolean).join(' · ');
  let md = `# ${book.title}\n\n${head}  \n<sub>Updated ${fmtDate(Date.now())} · kept with Lipat</sub>\n\n`;
  // untitled sections (e.g. a chapter split over several files) inherit the last known chapter name
  const ids = Object.keys(sectionTitles).sort((a, b) => secIndex(a) - secIndex(b));
  const effective = {}; let carry = '';
  for (const id of ids) { if (sectionTitles[id]) carry = sectionTitles[id]; effective[id] = carry; }
  let lastTitle = null;
  for (const m of ms) {
    const title = effective[m.sectionId] || `Section ${secIndex(m.sectionId) + 1}`;
    if (title !== lastTitle) { lastTitle = title; md += `## ${title}\n\n`; }
    md += markBlock(m);
  }
  if (!ms.length) md += '_Nothing kept from this book yet._\n';
  return md;
}

// One file per reaction across all books.
export function reactionMarkdown(reaction, books, marks) {
  const isBm = reaction === 'bm';
  const title = isBm ? '🔖 Bookmarks' : `${reaction} ${LABEL[reaction]}`;
  const list = marks.filter(m => isBm ? m.type === 'bookmark' : m.emoji === reaction);
  const byBook = new Map();
  for (const m of list) { if (!byBook.has(m.bookId)) byBook.set(m.bookId, []); byBook.get(m.bookId).push(m); }
  let md = `# ${title}\n\n${list.length} across ${byBook.size} book${byBook.size === 1 ? '' : 's'}  \n<sub>Updated ${fmtDate(Date.now())} · kept with Lipat</sub>\n\n`;
  const order = Array.from(byBook.keys()).sort((a, b) => (books[b]?.lastOpened || 0) - (books[a]?.lastOpened || 0));
  for (const bid of order) {
    const b = books[bid];
    md += `## ${b?.title || 'Unknown book'}${b?.author ? ` — ${b.author}` : ''}\n\n`;
    for (const m of sortMarks(byBook.get(bid))) md += markBlock(m);
  }
  if (!list.length) md += '_Nothing here yet._\n';
  return md;
}

// Index.md: the table of contents of the Lipat folder.
export function indexMarkdown(booksArr, marks) {
  const c = counts(marks);
  let md = `# Lipat\n\nEverything you kept while reading. One file per book in **Books/**, one file per reaction in **By reaction/**.  \n<sub>Updated ${fmtDate(Date.now())}</sub>\n\n`;
  md += `**${c.total} marks** · ${REACTIONS.map(r => `${r.e} ${c[r.e]}`).join(' · ')} · 🔖 ${c.bookmarks}\n\n## Books\n\n`;
  md += '| Book | Author | Marks | Reactions |\n|---|---|---:|---|\n';
  const rows = booksArr.map(b => ({ b, ms: marks.filter(m => m.bookId === b.id) })).filter(x => x.ms.length).sort((x, y) => (y.b.lastOpened || 0) - (x.b.lastOpened || 0));
  for (const { b, ms } of rows) {
    const cc = counts(ms);
    md += `| [${b.title.replace(/\|/g, '/')}](Books/${encodeURIComponent(safeName(b.title) + '.md')}) | ${b.author || ''} | ${ms.length} | ${REACTIONS.filter(r => cc[r.e]).map(r => `${r.e}${cc[r.e]}`).join(' ')}${cc.bookmarks ? ` 🔖${cc.bookmarks}` : ''} |\n`;
  }
  if (!rows.length) md += '| _nothing yet_ | | | |\n';
  return md;
}

// Single downloadable file with everything (or a filtered subset).
export function allMarksMarkdown(booksArr, marks, sectionTitlesByBook = {}) {
  const byId = Object.fromEntries(booksArr.map(b => [b.id, b]));
  const byBook = new Map();
  for (const m of marks) { if (!byBook.has(m.bookId)) byBook.set(m.bookId, []); byBook.get(m.bookId).push(m); }
  let md = `# Marks from Lipat\n\n${summaryLine(marks)}  \n<sub>${fmtDate(Date.now())}</sub>\n\n`;
  for (const [bid, ms] of byBook) {
    const b = byId[bid] || { title: 'Unknown book' };
    md += bookMarkdown(b, ms, sectionTitlesByBook[bid] || {}).replace(/^# /, '## ').replace(/\n## /g, '\n### ') + '\n---\n\n';
  }
  return md;
}
