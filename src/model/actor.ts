/** A person or a service as its token names it: an opaque key and a name to show. */
export interface Actor {
  readonly actorId: string;
  readonly label?: string;
  /** Named by the top claim of the instance, so every right holds everywhere; never stored. */
  readonly top?: true;
  /** Seconds since 1970 until the token is taken, tolerance included; left out, it never runs out. */
  readonly expiresAt?: number;
}

/** What every pseudonym begins with; a key that does is never taken as a person's. */
export const PSEUDONYM_PREFIX = 'anonymous-';

/** Whether a key looks like one the service makes up for a person writing anonymously. */
export function isPseudonym(key: string): boolean {
  return key.startsWith(PSEUDONYM_PREFIX);
}

/** What every key of a service begins with; a person's token never carries one. */
export const SERVICE_PREFIX = 'service-';

/** Whether a key belongs to a service that signs its own tokens, not to a person. */
export function isServiceKey(key: string): boolean {
  return key.startsWith(SERVICE_PREFIX);
}
