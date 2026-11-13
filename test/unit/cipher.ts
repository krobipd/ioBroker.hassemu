/**
 * A stand-in for the platform's cipher (`adapter.encrypt`, `adapter.decrypt`) — reversible, and visibly not the clear
 * text, so a test sees that the data file holds a secret sealed and reads it back. The real cipher needs the system
 * secret of an installation; the object inventory runs against one.
 */

const PREFIX = "sealed:";

/** Encrypt and decrypt the way a test needs it: the text in base64 behind a fixed prefix. */
export const TEST_CIPHER = {
  /**
   * @param value the clear text
   * @returns the sealed text
   */
  encrypt: (value: string): string => `${PREFIX}${Buffer.from(value, "utf8").toString("base64")}`,
  /**
   * @param value what {@link TEST_CIPHER.encrypt} made
   * @returns the clear text — anything else gives text that is no JSON, as a wrong key does on the real cipher
   */
  decrypt: (value: string): string =>
    value.startsWith(PREFIX) ? Buffer.from(value.slice(PREFIX.length), "base64").toString("utf8") : "\u0000",
};
