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

function withSlug(base: string, className: string): string {
  const slug = slugify(className)
  if (!slug) {
    return base
  }
  return `${base}/${encodeURIComponent(slug)}`
}

export function classPath(classToken: string, className: string): string {
  return withSlug(`/c/${classToken}`, className)
}

/** The class's public Top 3 page, beside the class page rather than under it so no class slug can clash with it. */
export function topPath(classToken: string, className: string): string {
  return withSlug(`/top/${classToken}`, className)
}
