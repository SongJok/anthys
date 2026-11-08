const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x')) return safeCodePoint(parseInt(body.slice(2), 16), whole);
    if (body.startsWith('#')) return safeCodePoint(parseInt(body.slice(1), 10), whole);
    return NAMED[body] ?? whole;
  });
}

function safeCodePoint(code: number, fallback: string): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/** 取得属性值 */
export function attr(tagSource: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(tagSource);
  return match ? decodeXml(match[1]!) : undefined;
}

/** 拼接某段 XML 内所有 <prefix:t> 文本 */
export function collectText(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  let out = '';
  for (const m of xml.matchAll(re)) out += decodeXml(m[1]!);
  return out;
}
