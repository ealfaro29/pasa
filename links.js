/** Local-only link parsing. Nothing in this module makes a network request. */
const MAX_LINKS = 12;
const COLORS = {
  web: '#7c8a96', youtube: '#ff5252', github: '#c9d1d9', x: '#b8c3cd',
  instagram: '#f16faa', tiktok: '#58e3dc', notion: '#d8dee3', figma: '#ae8aff',
  google: '#79a8ff', canva: '#46d3d7', linkedin: '#65a9ee', spotify: '#54d88b',
  wikipedia: '#c7cdd2',
};

function parseSafeUrl(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()) return null;
  if (/[\u0000-\u0020\u007f\\]/u.test(value)) return null;
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
    // Reject even an empty user-info field, so the displayed host is unambiguous.
    if (url.username || url.password || /^https?:\/\/[^/?#]*@/i.test(value)) return null;
    return url;
  } catch {
    return null;
  }
}

function trimPunctuation(value) {
  const pairs = { ')': '(', ']': '[', '}': '{' };
  const counts = { '(': 0, ')': 0, '[': 0, ']': 0, '{': 0, '}': 0 };
  for (const char of value) if (Object.hasOwn(counts, char)) counts[char]++;
  let end = value.length;
  while (end > 0) {
    const char = value[end - 1];
    if (/[.,;:!?…。。，；：！？»”’]/u.test(char)) {
      end--;
    } else if (Object.hasOwn(pairs, char) && counts[char] > counts[pairs[char]]) {
      counts[char]--;
      end--;
    } else break;
  }
  return value.slice(0, end);
}

/** Extract up to twelve distinct, safe HTTP(S) links, preserving their first spelling. */
export function extractLinks(text) {
  if (typeof text !== 'string') return [];
  const links = [];
  const seen = new Set();
  for (const match of text.matchAll(/(?:https?:\/\/|www\.)[^\s<>"'`]+/giu)) {
    const index = match.index;
    const previous = text[index - 1] ?? '';
    // Do not find a nested URL inside another scheme, address, or URL parameter.
    if (/[\p{L}\p{N}_:/@\\.\-?=&%#]/u.test(previous)) continue;
    const prefix = text.slice(0, index).split(/[\s<>"'`()[\]{}]/u).at(-1);
    if (/(?:javascript|data|vbscript):/i.test(prefix)) continue;
    const candidate = trimPunctuation(match[0]);
    const href = /^www\./i.test(candidate) ? `https://${candidate}` : candidate;
    const parsed = parseSafeUrl(href);
    if (!parsed || seen.has(parsed.href)) continue;
    seen.add(parsed.href);
    links.push(href);
    if (links.length === MAX_LINKS) break;
  }
  return links;
}

function decoded(value = '') {
  try { return decodeURIComponent(value); } catch { return value; }
}

function cleanTitle(value) {
  return decoded(value).replace(/[\u0000-\u001f\u007f-\u009f]/gu, '')
    .replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 110);
}

function usefulPathTitle(parts) {
  const ignored = /^(?:index(?:\.[a-z]+)?|home|edit|view|share|preview|app|en|es|en-us|es-es)$/i;
  for (const part of [...parts].reverse()) {
    const title = cleanTitle(part.replace(/\.(?:html?|php|aspx?)$/i, ''));
    if (!title || ignored.test(title) || /^\d+$/.test(title)) continue;
    if (/^[a-f\d]{16,}$/i.test(part) || /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(part)) continue;
    if (part.length > 35 && !/[-_\s]/.test(part)) continue;
    return title.charAt(0).toLocaleUpperCase('es') + title.slice(1);
  }
  return '';
}

/** Describe a link from its URL alone; metadata is deliberately never fetched. */
export function describeLink(href) {
  const parsed = parseSafeUrl(href);
  if (!parsed) {
    return { url: '', platform: 'Web', provider: 'Web', title: 'Enlace no válido', domain: '', kind: 'link', color: COLORS.web };
  }
  const domain = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const parts = parsed.pathname.split('/').filter(Boolean);
  const first = parts[0]?.toLowerCase() ?? '';
  const is = name => domain === name || domain.endsWith(`.${name}`);
  const label = (platform, title, kind = 'link', color = COLORS.web) => ({
    url: href, platform, provider: platform, title, domain, kind, color,
  });
  const person = value => cleanTitle(value).replace(/^@/, '');

  if (is('youtube.com') || domain === 'youtu.be') {
    if (first === 'shorts') return label('YouTube', 'Short de YouTube', 'short', COLORS.youtube);
    if (first === 'channel' || first === 'c' || first === 'user' || first.startsWith('@')) {
      const name = first.startsWith('@') ? parts[0] : parts[1];
      return label('YouTube', name ? `Canal de ${cleanTitle(name)}` : 'Canal de YouTube', 'channel', COLORS.youtube);
    }
    if (first === 'playlist') return label('YouTube', 'Playlist de YouTube', 'video', COLORS.youtube);
    return label('YouTube', 'Video de YouTube', 'video', COLORS.youtube);
  }

  if (domain === 'github.com') {
    const repo = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : '';
    if (repo && parts[2] === 'issues' && /^\d+$/.test(parts[3] ?? '')) {
      return label('GitHub', `Issue #${parts[3]} · ${repo}`, 'issue', COLORS.github);
    }
    if (repo && parts[2] === 'pull' && /^\d+$/.test(parts[3] ?? '')) {
      return label('GitHub', `Pull request #${parts[3]} · ${repo}`, 'pull', COLORS.github);
    }
    if (repo) return label('GitHub', repo, 'repository', COLORS.github);
    return label('GitHub', parts[0] ? `Perfil de ${cleanTitle(parts[0])}` : 'GitHub', parts[0] ? 'profile' : 'link', COLORS.github);
  }

  if (is('x.com') || is('twitter.com')) {
    if (parts[1] === 'status') return label('X', `Publicación de @${person(parts[0])}`, 'post', COLORS.x);
    const reserved = ['home', 'explore', 'search', 'i', 'messages', 'settings', 'intent'];
    if (parts[0] && !reserved.includes(first)) return label('X', `Perfil de @${person(parts[0])}`, 'profile', COLORS.x);
    return label('X', 'Enlace de X', 'link', COLORS.x);
  }

  if (is('instagram.com')) {
    if (first === 'p') return label('Instagram', 'Publicación de Instagram', 'post', COLORS.instagram);
    if (first === 'reel' || first === 'reels') return label('Instagram', 'Reel de Instagram', 'reel', COLORS.instagram);
    if (parts[0] && !['explore', 'accounts', 'direct', 'stories'].includes(first)) {
      return label('Instagram', `Perfil de @${person(parts[0])}`, 'profile', COLORS.instagram);
    }
    return label('Instagram', 'Enlace de Instagram', 'link', COLORS.instagram);
  }

  if (is('tiktok.com')) {
    if (parts[0]?.startsWith('@')) {
      const name = person(parts[0]);
      return label('TikTok', parts[1] === 'video' ? `Video de @${name}` : `Perfil de @${name}`, parts[1] === 'video' ? 'video' : 'profile', COLORS.tiktok);
    }
    return label('TikTok', 'Video de TikTok', 'video', COLORS.tiktok);
  }

  if (is('notion.so') || is('notion.site')) {
    const title = usefulPathTitle(parts.map(part => part.replace(/-?[a-f\d]{32}$/i, '')));
    return label('Notion', title || 'Página de Notion', 'document', COLORS.notion);
  }

  if (is('figma.com')) {
    const name = ['design', 'file', 'proto', 'board', 'slides'].includes(first) ? cleanTitle(parts[2]) : '';
    return label('Figma', name || 'Diseño en Figma', 'design', COLORS.figma);
  }

  if (domain === 'docs.google.com') {
    if (first === 'spreadsheets') return label('Google Sheets', 'Hoja de cálculo de Google', 'spreadsheet', COLORS.google);
    if (first === 'presentation') return label('Google Slides', 'Presentación de Google', 'presentation', COLORS.google);
    if (first === 'forms') return label('Google Forms', 'Formulario de Google', 'document', COLORS.google);
    return label('Google Docs', 'Documento de Google', 'document', COLORS.google);
  }
  if (domain === 'drive.google.com') return label('Google Drive', first === 'drive' && parts.includes('folders') ? 'Carpeta de Google Drive' : 'Archivo de Google Drive', 'file', COLORS.google);
  if (is('canva.com')) return label('Canva', 'Diseño en Canva', 'design', COLORS.canva);

  if (is('linkedin.com')) {
    if (first === 'in') return label('LinkedIn', parts[1] ? `Perfil de ${cleanTitle(parts[1])}` : 'Perfil de LinkedIn', 'profile', COLORS.linkedin);
    if (first === 'posts' || first === 'feed') return label('LinkedIn', 'Publicación de LinkedIn', 'post', COLORS.linkedin);
    if (first === 'jobs') return label('LinkedIn', 'Empleo en LinkedIn', 'link', COLORS.linkedin);
    return label('LinkedIn', 'Enlace de LinkedIn', 'link', COLORS.linkedin);
  }

  if (is('spotify.com')) {
    const type = { track: 'Canción', album: 'Álbum', playlist: 'Playlist', artist: 'Artista', episode: 'Episodio', show: 'Podcast' };
    const key = first.startsWith('intl-') ? parts[1] : first;
    return label('Spotify', `${type[key] || 'Enlace'} de Spotify`, 'music', COLORS.spotify);
  }

  if (is('wikipedia.org')) {
    const title = first === 'wiki' ? cleanTitle(parts.slice(1).join('/')) : '';
    return label('Wikipedia', title || 'Artículo de Wikipedia', 'article', COLORS.wikipedia);
  }

  return label('Web', usefulPathTitle(parts) || domain, 'link', COLORS.web);
}

/** Compact display only; callers must keep the original href for navigation. */
export function shortenUrl(href, max = 80) {
  const parsed = parseSafeUrl(href);
  if (!parsed) return '';
  const limit = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : 80;
  const display = href.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  return display.length <= limit ? display : `${display.slice(0, Math.max(0, limit - 1))}…`;
}
