// Content that must never ship in dist/ (checked by scripts/verify-package.mjs,
// patterns tested by tests/forbidden.test.mjs).
export const FORBIDDEN = [
  [/lightningchart|\bLCJS\b|arction/i, 'third-party product name'],
  [/globalThis\.__sferic|window\.__sferic/, 'debug global'],
  [/[A-Za-z]:[\\/]+Users[\\/]/, 'local absolute path (Windows home)'],
  // /home/<user>/ or /Users/<user>/, but not a URL path such as example.com/home/x/
  [/(?<![\w.-])\/(?:home|Users)\/[^\s/'"`]+\//, 'local absolute path (Linux/macOS home)'],
]

/** Labels of the forbidden patterns found in s. */
export const forbiddenIn = (s) => FORBIDDEN.filter(([re]) => re.test(s)).map(([, what]) => what)
