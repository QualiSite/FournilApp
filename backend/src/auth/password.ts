import argon2 from 'argon2';

/** Hash argon2id (paramètres par défaut de la lib, déjà raisonnables en 2026). */
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password);
}

export function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

/**
 * Hash "leurre" valide (argon2id, paramètres par défaut), sans mot de passe associé.
 * Sert uniquement à faire tourner argon2.verify() à temps constant quand l'email
 * n'existe pas en base — sinon la réponse de /api/auth/login serait mesurablement
 * plus rapide pour un email inconnu que pour un email valide, ce qui permettrait
 * de deviner quels comptes existent (attaque par canal temporel).
 */
export const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$nVX57WLXjo6pOpe18hcy9g$UBGFktKWL7WA8FM9ighs6118N8ZnkwmsWGmX/AmTg8g';
