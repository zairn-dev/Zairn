/** Thrown when the server is missing required secret configuration. */
export class ServerConfigError extends Error {}

/**
 * Resolve the server encryption secret for a secret version. Supports
 * rotation via GEODROP_ENCRYPTION_SECRET_V{n}, falling back to the unversioned
 * GEODROP_ENCRYPTION_SECRET. FAIL CLOSED: without a secret the location key
 * would be derivable from the drop's own columns, so refuse instead.
 */
export function resolveServerSecret(version: number): string {
  const versioned = Deno.env.get(`GEODROP_ENCRYPTION_SECRET_V${version}`)
  const secret = versioned ?? Deno.env.get('GEODROP_ENCRYPTION_SECRET')
  if (!secret) {
    throw new ServerConfigError(
      'GEODROP_ENCRYPTION_SECRET is not configured — refusing to derive keys predictable from public data',
    )
  }
  return secret
}

/**
 * Secret version for NEW drops: GEODROP_CURRENT_SECRET_VERSION if set,
 * otherwise 1 (the unversioned secret). Old drops keep the version they
 * were created with, so rotation never breaks decryption.
 */
export function currentSecretVersion(): number {
  const raw = Deno.env.get('GEODROP_CURRENT_SECRET_VERSION')
  const version = raw ? Number(raw) : 1
  if (!Number.isInteger(version) || version < 1) {
    throw new ServerConfigError('GEODROP_CURRENT_SECRET_VERSION must be a positive integer')
  }
  return version
}
