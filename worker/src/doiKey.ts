// Paper Fetch Hub's DOI key, ported from paper-fetch-hub/web/src/doi.ts (keep in step with it and with
// shared/doi-vectors.json there, copied to ./doi-vectors.json). Its PDFs are stored in R2 at
// `papers/{doiKey}.pdf`.

const PREFIX = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i;
const TRAILING = /[.,;:\s]+$/; // Sentence punctuation picked up when copying.
const VALID = /^10\.\d{4,9}\/\S+$/;

export function normaliseDoi(raw: string): string | null {
  const doi = raw.trim().replace(PREFIX, '').trim().toLowerCase().replace(TRAILING, '');
  return VALID.test(doi) ? doi : null;
}

export async function doiKey(raw: string): Promise<string | null> {
  const doi = normaliseDoi(raw);
  if (!doi) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(doi));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
