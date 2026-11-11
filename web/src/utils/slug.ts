const MAX_SLUG_LENGTH = 60

/** Readable URL tail for a class name. Keeps letters and digits of any script, so Arabic names stay readable. */
export function slugify(name: string): string {
  return name
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '')
}

export function classPath(classToken: string, className: string): string {
  const slug = slugify(className)
  const base = `/c/${classToken}`
  if (!slug) {
    return base
  }
  return `${base}/${encodeURIComponent(slug)}`
}
