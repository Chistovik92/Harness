/**
 * Encrypted JSON file with serialised read-modify-write cycles, atomic writes
 * and quarantine of unreadable files (so a bad file is never silently overwritten).
 */

import fs from 'node:fs'
import { encrypt, decrypt } from './secureStore'

export class EncryptedStore<T> {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly getKey: () => Promise<Buffer>,
    private readonly empty: () => T,
  ) {}

  async read(): Promise<T> {
    if (!fs.existsSync(this.filePath)) return this.empty()
    try {
      const raw = await fs.promises.readFile(this.filePath, 'utf-8')
      return JSON.parse(decrypt(raw, await this.getKey())) as T
    } catch (err) {
      console.error(`Store ${this.filePath} unreadable, moving aside:`, err)
      await fs.promises.rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`).catch(() => {})
      return this.empty()
    }
  }

  private async write(value: T): Promise<void> {
    const encrypted = encrypt(JSON.stringify(value), await this.getKey())
    const tmp = `${this.filePath}.tmp`
    await fs.promises.writeFile(tmp, encrypted, { mode: 0o600 })
    await fs.promises.rename(tmp, this.filePath)
  }

  /** Reads, transforms and writes under a lock so concurrent callers cannot lose updates. */
  update<R>(fn: (current: T) => { value: T; result: R }): Promise<R> {
    const run = this.queue.then(async () => {
      const { value, result } = fn(await this.read())
      await this.write(value)
      return result
    })
    this.queue = run.catch(() => {})
    return run
  }

  clear(): Promise<void> {
    const run = this.queue.then(() => fs.promises.rm(this.filePath, { force: true }))
    this.queue = run.catch(() => {})
    return run
  }
}
