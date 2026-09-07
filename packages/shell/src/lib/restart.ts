/** Service restart was introduced in engine 1.5.4. */
export function supportsRestart(version: string | null): boolean {
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)
  if (!match) return false
  const [major, minor, patch] = match.slice(1, 4).map(Number)
  return major! > 1 || major === 1 && (minor! > 5 || minor === 5 && patch! >= 4)
}
