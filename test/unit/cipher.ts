/**
 * A stand-in for the platform's cipher (`adapter.encrypt`, `adapter.decrypt`) — the one fleet form of a test's adapter
 * stand-in (`CLAUDE_PATTERNS.md`, § Geheimnisse, S7): reversible, with the platform's prefix, so a test sees that the
 * data file holds a secret sealed and reads it back. The real cipher needs the system secret of an installation; the
 * object inventory runs against one. A test of a wrong key brings its own `decrypt`.
 */
export const TEST_CIPHER = {
  /**
   * @param value the clear text
   * @returns the sealed text
   */
  encrypt(value: string): string {
    return `$/aes-192-cbc:${Buffer.from(value).toString("base64")}`;
  },
  /**
   * @param value what {@link TEST_CIPHER.encrypt} made
   * @returns the clear text
   */
  decrypt(value: string): string {
    return Buffer.from(value.replace("$/aes-192-cbc:", ""), "base64").toString();
  },
};
