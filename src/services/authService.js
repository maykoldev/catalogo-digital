const crypto = require('crypto');

class AuthService {
  /**
   * Hashes a password using PBKDF2 with SHA-512 and a random salt
   */
  static hashPassword(password, salt = null) {
    if (!salt) {
      salt = crypto.randomBytes(16).toString('hex');
    }
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return { hash, salt };
  }

  /**
   * Verifies if the provided password matches the stored hash
   */
  static verifyPassword(password, storedHash, salt) {
    const { hash } = this.hashPassword(password, salt);
    const hashBuf = Buffer.from(hash, 'hex');
    const storedBuf = Buffer.from(storedHash, 'hex');
    if (hashBuf.length !== storedBuf.length) return false;
    return crypto.timingSafeEqual(hashBuf, storedBuf);
  }

  /**
   * Generates a cryptographically strong session token
   */
  static generateSessionToken() {
    return crypto.randomBytes(32).toString('hex');
  }
}

module.exports = AuthService;
