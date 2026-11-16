import { extractLinks } from './links.js?v=3.3.0';

// Remove every spelling of a hidden URL, including canonical duplicates, while
// preserving prose and the punctuation surrounding a pasted link.
function withoutLinks(text, hidden) {
  return text.replace(/(?:https?:\/\/|www\.)[^\s<>"'`]+/giu, token => {
    const candidate = extractLinks(token)[0];
    if (!candidate || !hidden.has(new URL(candidate).href)) return token;
    const spelling = /^www\./i.test(token) ? candidate.replace(/^https:\/\//, '') : candidate;
    return token.replace(spelling, '');
  });
}

export function messageView(message, archives, archivedView) {
  if (message.kind === 'file' || message.kind === 'file-delete' || message.kind === 'archive') return null;
  const links = extractLinks(message.text);
  const wholeArchived = archives.isMessageArchived(message.id);
  if (wholeArchived !== archivedView && (wholeArchived || !links.length)) return null;
  const visibleLinks = links.filter(url => archives.isArchived(message.id, new URL(url).href) === archivedView);
  const hidden = new Set(links.filter(url => !visibleLinks.includes(url)).map(url => new URL(url).href));
  let text = archivedView && !wholeArchived ? '' : withoutLinks(message.text, hidden).trim();
  const prose = withoutLinks(message.text, new Set(links.map(url => new URL(url).href))).replace(/[\s.,;:()\[\]{}•\-]/g, '');
  if (links.length && !visibleLinks.length && (!prose || archivedView)) return null;
  if (links.length && !prose) text = '';
  return { links, visibleLinks, text,
    copy: [text, ...visibleLinks.filter(url => !text.includes(url))].filter(Boolean).join('\n') };
}
