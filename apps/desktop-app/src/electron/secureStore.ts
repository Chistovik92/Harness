/**
 * AES-256-GCM helpers for the encrypted provider store.
 *
 * Payload format: `v1.<iv>.<ciphertext>.<authTag>` (all base64). The auth tag
 * is mandatory: without it GCM cannot detect tampering and decryption fails.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const VERSION = 'v1'

export function generateKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

export function isValidKey(key: Buffer): boolean {
  return key.length === KEY_BYTES
}

export function encrypt(text: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, iv.toString('base64'), ciphertext.toString('base64'), tag.toString('base64')].join('.')
}

export function decrypt(payload: string, key: Buffer): string {
  const [version, ivB64, ctB64, tagB64] = payload.trim().split('.')
  if (version !== VERSION || !ivB64 || ctB64 === undefined || !tagB64) {
    throw new Error('Unsupported or corrupted encrypted payload')
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8')
}
