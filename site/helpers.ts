// Shared helpers for zero-dependency static HTML generation & source-code cross-referencing.

export const REPO_URL = 'https://github.com/pandazki/pneuma-space';

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const bi = (en: string, zh: string): string =>
  `<span data-lang="en">${en}</span><span data-lang="zh">${zh}</span>`;

export const biBlock = (en: string, zh: string, cls = ''): string =>
  `<div data-lang="en"${cls ? ` class="${cls}"` : ''}>${en}</div><div data-lang="zh"${cls ? ` class="${cls}"` : ''}>${zh}</div>`;

export const ICONS = {
  code: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="5 4 1 8 5 12"/><polyline points="11 4 15 8 11 12"/></svg>`,
  file: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 1.5H4a1.5 1.5 0 0 0-1.5 1.5v10A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5V6L9 1.5Z"/><polyline points="9 1.5 9 6 13.5 6"/></svg>`,
  copy: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1.5"/><path d="M3.5 10.5H2.8A1.3 1.3 0 0 1 1.5 9.2V2.8A1.3 1.3 0 0 1 2.8 1.5h6.4a1.3 1.3 0 0 1 1.3 1.3v.7"/></svg>`,
  search: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7" cy="7" r="4.8"/><line x1="10.6" y1="10.6" x2="14.2" y2="14.2"/></svg>`,
  github: `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 .2a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38l-.01-1.49c-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48l-.01 2.2c0 .21.15.46.55.38A8.01 8.01 0 0 0 8 .2Z"/></svg>`,
  sun: `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="3.2"/><line x1="8" y1="1.2" x2="8" y2="2.6"/><line x1="8" y1="13.4" x2="8" y2="14.8"/><line x1="3.2" y1="3.2" x2="4.2" y2="4.2"/><line x1="11.8" y1="11.8" x2="12.8" y2="12.8"/><line x1="1.2" y1="8" x2="2.6" y2="8"/><line x1="13.4" y1="8" x2="14.8" y2="8"/><line x1="3.2" y1="12.8" x2="4.2" y2="11.8"/><line x1="11.8" y1="4.2" x2="12.8" y2="3.2"/></svg>`,
  moon: `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 9.8A5.8 5.8 0 0 1 6.2 2.5a5.8 5.8 0 1 0 7.3 7.3Z"/></svg>`,
};

/** Renders a clickable source-code badge linking directly to GitHub file & line range. */
export function srcRef(path: string, lines?: string, customLabel?: string): string {
  const hash = lines ? `#${lines}` : '';
  const display = customLabel ?? (lines ? `${path}:${lines}` : path);
  return `<a class="src-ref" href="${REPO_URL}/blob/main/${path}${hash}" target="_blank" rel="noopener" title="Inspect source: ${esc(display)}">${ICONS.code}<span>${esc(display)}</span></a>`;
}

/** Renders a code plate with a title bar, optional source link, and a copy button. */
export function codePlate(title: string, code: string, srcBadge = ''): string {
  return `<div class="code-plate">
  <div class="code-plate-bar">
    <span>${title}</span>
    <span class="chips">${srcBadge}<button type="button" class="copy-btn" data-copy-target="">${ICONS.copy}<span class="copy-label">${bi('Copy', '复制')}</span></button></span>
  </div>
  <pre><code>${esc(code)}</code></pre>
</div>`;
}

/** Zero-dependency Markdown-to-HTML renderer for ADR documents and specification tables. */
export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inCode = false;
  let codeLang = '';
  let codeBuf: string[] = [];
  let inTable = false;
  let tableRows: string[][] = [];
  let inList: 'ul' | 'ol' | null = null;
  let paraBuf: string[] = [];

  const inline = (text: string): string => {
    let s = esc(text);
    // Inline code
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Bold
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Links [label](href)
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
      let resolved = href;
      if (/^\d{4}-.*\.md/.test(href)) {
        const num = href.slice(0, 4);
        resolved = `./adr.html#adr-${num}`;
      } else if (href.includes('app-contract.md')) {
        resolved = './contract.html';
      } else if (href.includes('REQUIREMENTS')) {
        resolved = './planes.html';
      } else if (href.includes('DESIGN.md')) {
        resolved = './architecture.html';
      } else if (!href.startsWith('http') && !href.startsWith('#') && !href.startsWith('./')) {
        resolved = `${REPO_URL}/blob/main/${href.replace(/^(\.\.\/)+/, '')}`;
      }
      const ext = resolved.startsWith('http') ? ' target="_blank" rel="noopener"' : '';
      return `<a href="${resolved}"${ext}>${label}</a>`;
    });
    return s;
  };

  const flushPara = () => {
    if (paraBuf.length) {
      out.push(`<p>${inline(paraBuf.join(' '))}</p>`);
      paraBuf = [];
    }
  };

  const flushList = () => {
    if (inList) {
      out.push(`</${inList}>`);
      inList = null;
    }
  };

  const flushTable = () => {
    if (!inTable) return;
    inTable = false;
    if (tableRows.length >= 2) {
      const head = tableRows[0];
      const body = tableRows.slice(2);
      out.push('<div class="table-wrap"><table class="spec-table"><thead><tr>');
      for (const h of head) out.push(`<th>${inline(h)}</th>`);
      out.push('</tr></thead><tbody>');
      for (const row of body) {
        out.push('<tr>');
        for (const cell of row) out.push(`<td>${inline(cell)}</td>`);
        out.push('</tr>');
      }
      out.push('</tbody></table></div>');
    }
    tableRows = [];
  };

  for (const rawLine of lines) {
    const line = rawLine;
    if (line.trim().startsWith('```')) {
      flushPara();
      flushList();
      flushTable();
      if (!inCode) {
        inCode = true;
        codeLang = line.trim().slice(3).trim() || 'text';
        codeBuf = [];
      } else {
        inCode = false;
        out.push(codePlate(esc(codeLang), codeBuf.join('\n')));
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (trimmed === '') {
      flushPara();
      flushList();
      flushTable();
      continue;
    }

    // Table row
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      flushPara();
      flushList();
      inTable = true;
      const cells = trimmed.slice(1, -1).split('|').map((c) => c.trim());
      tableRows.push(cells);
      continue;
    } else if (inTable) {
      flushTable();
    }

    // Headings (# title is skipped because the ADR card summary already renders it)
    const hMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (hMatch) {
      flushPara();
      flushList();
      const level = hMatch[1].length;
      if (level === 1) continue;
      const tag = level === 2 ? 'h3' : 'h4';
      out.push(`<${tag}>${inline(hMatch[2])}</${tag}>`);
      continue;
    }

    // Unordered list
    const ulMatch = /^[-*]\s+(.+)$/.exec(trimmed);
    if (ulMatch) {
      flushPara();
      if (inList !== 'ul') {
        flushList();
        inList = 'ul';
        out.push('<ul>');
      }
      out.push(`<li>${inline(ulMatch[1])}</li>`);
      continue;
    }

    // Ordered list
    const olMatch = /^\d+\.\s+(.+)$/.exec(trimmed);
    if (olMatch) {
      flushPara();
      if (inList !== 'ol') {
        flushList();
        inList = 'ol';
        out.push('<ol>');
      }
      out.push(`<li>${inline(olMatch[1])}</li>`);
      continue;
    }

    paraBuf.push(trimmed);
  }

  flushPara();
  flushList();
  flushTable();
  return `<div class="prose">${out.join('\n')}</div>`;
}
