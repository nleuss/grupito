// Minimal browser stand-in for Node's "path" (kuromoji only uses join on URLs).
export function join(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+|\/+$/g, '')))
    .join('/');
}
export default { join };
