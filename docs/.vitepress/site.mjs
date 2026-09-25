/**
 * The single place this project's published identity is defined.
 *
 * The rule: SITE_ORIGIN is for URLs THIS SITE SERVES. Everything else belongs
 * to somebody else's namespace and must not derive from it — the repository
 * name, the GitHub handle, github.com, api.github.com and
 * raw.githubusercontent.com URLs, and any asset GitHub serves rather than this
 * site. Those change on a different schedule, or never, and folding them in
 * here is how a hostname change quietly rewrites something that was never a
 * site URL.
 *
 * Changing where these docs are published is changing SITE_ORIGIN and nothing
 * else. tests/unit/site-origin.test.ts fails if the literal hostname appears
 * anywhere outside this file, or if built output points at an unexpected host.
 */
export const SITE_ORIGIN = 'https://xsavikx.github.io';

/** Path this site is served under, with both slashes. Not part of the origin. */
export const SITE_BASE = '/cloud-cache-action/';

/** Absolute base of every published page, with a trailing slash. */
export const SITE_URL = `${SITE_ORIGIN}${SITE_BASE}`;

/**
 * Deliberately NOT an allowlist of external hosts.
 *
 * Asserting that every absolute URL in built output is either ours or on an
 * allowlist works for a small hand-authored page, but not here: these docs
 * legitimately contain dozens of example endpoints (localhost:9000,
 * s3.<region>.backblazeb2.com, minio.internal), vendor links, XML namespace
 * URIs and framework URLs inside bundled JS. The allowlist would be noise, and
 * a noisy test gets disabled.
 *
 * What is worth asserting is narrower and stronger: every SELF-REFERENTIAL
 * surface - sitemap <loc>, canonical, og:url, the Sitemap: directive - must
 * derive from SITE_URL. See tests/unit/siteOrigin.test.ts.
 */
