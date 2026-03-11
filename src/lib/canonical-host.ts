const HEROKU_HOST_SUFFIX = '.herokuapp.com';

export function normalizeOrigin(origin?: string | null): string | null {
  const value = origin?.trim();
  if (!value) {
    return null;
  }

  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function getCanonicalBaseOrigin(): string | null {
  return normalizeOrigin(process.env.NEXT_PUBLIC_BASE_URL);
}

export function isHerokuHostname(hostname?: string | null): boolean {
  const value = hostname?.trim().toLowerCase();
  return Boolean(value && value.endsWith(HEROKU_HOST_SUFFIX));
}

export function preferCanonicalOrigin(origin?: string | null): string | null {
  const normalizedOrigin = normalizeOrigin(origin);
  const canonicalOrigin = getCanonicalBaseOrigin();

  if (!normalizedOrigin) {
    return canonicalOrigin;
  }

  if (!canonicalOrigin) {
    return normalizedOrigin;
  }

  try {
    const requestUrl = new URL(normalizedOrigin);
    const canonicalUrl = new URL(canonicalOrigin);

    if (
      requestUrl.origin !== canonicalUrl.origin &&
      isHerokuHostname(requestUrl.hostname)
    ) {
      return canonicalUrl.origin;
    }
  } catch {
    return canonicalOrigin;
  }

  return normalizedOrigin;
}
