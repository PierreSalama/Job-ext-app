// Minimal Markdown renderer. Handles:
//  - **bold** / *italic*
//  - `code`
//  - ```code blocks```
//  - # / ## / ### headings
//  - - / * lists
//  - 1. ordered lists
//  - > blockquote
//  - [text](url) links (links open in new tab; content-script side ensures rel=noreferrer)
//  - paragraphs (blank-line separated)
//
// HTML output is escaped for safety, then a small subset of inline markers is
// applied via regex passes. Not full CommonMark — just enough to make notes
// look great without pulling in a library.

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(s) {
  // Apply in order: code → bold → italic → links
  return s
    .replace(/`([^`]+)`/g, (_, code) => `<code>${esc(code)}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, (_, t) => `<strong>${t}</strong>`)
    .replace(/\b_([^_]+)_\b/g, (_, t) => `<em>${t}</em>`)
    .replace(/(?<!\*)\*([^*\s][^*]*?)\*(?!\*)/g, (_, t) => `<em>${t}</em>`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
      // url is already escaped by esc() at line level — re-escape just for href safety
      const safeUrl = /^https?:\/\//i.test(url) ? url : `#${url}`;
      return `<a href="${esc(safeUrl)}" target="_blank" rel="noreferrer noopener">${text}</a>`;
    });
}

export function renderMarkdown(src) {
  if (!src) return '';
  // Split by code blocks first to keep their content untouched
  const codeBlocks = [];
  let body = String(src).replace(/```([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(code);
    return `CODE${codeBlocks.length - 1}`;
  });

  body = esc(body); // escape everything

  // Headings
  body = body
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Blockquotes
  body = body.replace(/(^|\n)&gt; (.+(?:\n&gt; .+)*)/g, (_, lead, blk) => {
    const content = blk.replace(/^&gt; /gm, '');
    return `${lead}<blockquote>${content}</blockquote>`;
  });

  // Unordered lists
  body = body.replace(/(?:^|\n)((?:[-*] .+(?:\n|$))+)/g, (m, block) => {
    const items = block.trim().split(/\n/).map((l) => `<li>${l.replace(/^[-*] /, '')}</li>`).join('');
    return `\n<ul>${items}</ul>`;
  });

  // Ordered lists
  body = body.replace(/(?:^|\n)((?:\d+\. .+(?:\n|$))+)/g, (m, block) => {
    const items = block.trim().split(/\n/).map((l) => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('');
    return `\n<ol>${items}</ol>`;
  });

  // Paragraphs (separate by blank lines)
  body = body.split(/\n{2,}/).map((para) => {
    para = para.trim();
    if (!para) return '';
    if (/^<(?:h\d|ul|ol|blockquote|pre)/.test(para)) return para;
    return `<p>${para.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');

  // Inline formatting — apply once over everything
  // (we already escaped; inline() just adds tags)
  body = inline(body);

  // Restore code blocks
  body = body.replace(/CODE(\d+)/g, (_, i) => `<pre><code>${esc(codeBlocks[Number(i)])}</code></pre>`);

  return body;
}
