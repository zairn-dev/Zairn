/**
 * Structured error codes for @zairn/geo-drop
 *
 * Usage:
 *   try { await gd.unlockDrop(...) }
 *   catch (e) {
 *     if (e instanceof GeoDropError) {
 *       switch (e.code) {
 *         case 'DROP_EXPIRED': showExpiredUI(); break;
 *         case 'PASSWORD_REQUIRED': showPasswordPrompt(); break;
 *       }
 *     }
 *   }
 */

export type GeoDropErrorCode =
  | 'NOT_AUTHENTICATED'
  | 'DROP_NOT_FOUND'
  | 'DROP_EXPIRED'
  | 'DROP_INACTIVE'
  | 'DROP_MAX_CLAIMS'
  | 'PASSWORD_REQUIRED'
  | 'PASSWORD_INCORRECT'
  | 'VERIFICATION_FAILED'
  | 'NO_CONTENT'
  | 'INVALID_INPUT'
  | 'SUSPICIOUS_MOVEMENT'
  | 'CHAIN_REVERTED'
  | 'IPFS_INTEGRITY_FAILED'
  | 'ENCRYPTION_ERROR'
  | 'SIGNER_REQUIRED'
  | 'CHAIN_REQUIRED';

export class GeoDropError extends Error {
  readonly code: GeoDropErrorCode;
  /** Additional context for debugging */
  readonly details?: Record<string, unknown>;

  constructor(code: GeoDropErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'GeoDropError';
    this.code = code;
    this.details = details;
  }
}
