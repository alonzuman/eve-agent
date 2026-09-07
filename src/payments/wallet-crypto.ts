import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { walletRecordSchema, type WalletOwner, type WalletRecord } from "./wallet-types.js";

export function walletEncryptionKey(value = process.env.LINK_WALLET_ENCRYPTION_KEY): Buffer {
  if (!value || !/^[a-fA-F0-9]{64}$/.test(value)) throw new Error("Link wallet encryption is not configured.");
  return Buffer.from(value, "hex");
}

function associatedData(owner: WalletOwner): Buffer {
  if (![owner.namespace, owner.principalId].every(value => /^[a-f0-9]{64}$/.test(value))) {
    throw new Error("Invalid wallet owner.");
  }
  return Buffer.from(JSON.stringify(["eve-link-wallet", 1, owner.namespace, owner.principalId]));
}

export function encryptWallet(owner: WalletOwner, record: WalletRecord, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(associatedData(owner));
  const data = Buffer.concat([cipher.update(JSON.stringify(walletRecordSchema.parse(record)), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(".");
}

export function decryptWallet(owner: WalletOwner, ciphertext: string, key: Buffer): WalletRecord {
  try {
    const [version, iv, tag, data, extra] = ciphertext.split(".");
    if (version !== "v1" || !iv || !tag || !data || extra !== undefined) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAAD(associatedData(owner));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]);
    return walletRecordSchema.parse(JSON.parse(plain.toString("utf8")));
  } catch {
    // Crypto/parser errors must never carry stored data into workflow logs.
    throw new Error("Unable to open this user's Link connection.");
  }
}
