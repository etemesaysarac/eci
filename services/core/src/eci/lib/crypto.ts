import crypto from "crypto";

function getKey(): Buffer {
  const b64 = process.env.ECI_ENCRYPTION_KEY_BASE64;
  if (!b64) throw new Error("ECI_ENCRYPTION_KEY_BASE64 missing");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error("ECI_ENCRYPTION_KEY_BASE64 must be 32 bytes (base64)");
  return key;
}

export function encryptJson(obj: unknown): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const plaintext = Buffer.from(JSON.stringify(obj), "utf8");
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptJson<T>(payloadB64: string): T {
  const key = getKey();
  const buf = Buffer.from(payloadB64, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return JSON.parse(dec.toString("utf8")) as T;
}
