// Shared, non-secret application constants.
//
// Keep this module free of secrets — anything referenced here may be inlined
// into the client bundle (NEXT_PUBLIC_* values) or imported by client
// components.

// Public support address shown in the landing footer, FAQ, and other
// user-facing help surfaces. Env-driven so it can be repointed per
// deployment without code changes. Defaults to the org address so the build
// is never wired to a personal inbox.
//
// NEXT_PUBLIC_ because it is rendered in client components (e.g. the landing
// footer / FAQ). A support address is not a secret, so client exposure is
// expected and safe.
export const SUPPORT_EMAIL =
  process.env.NEXT_PUBLIC_SUPPORT_EMAIL?.trim() || 'support@njangi.app';

// Convenience mailto: link for the support address.
export const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}`;
