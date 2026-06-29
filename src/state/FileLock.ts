import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../utils/logger.js";
import { sleep } from "../utils/time.js";

interface FileLockOptions {
  staleMs: number;
  waitMs: number;
  pollMs: number;
}

const defaultOptions: FileLockOptions = {
  staleMs: 180_000,
  waitMs: 180_000,
  pollMs: 1_000
};

export class FileLock {
  constructor(
    private readonly lockPath: string,
    private readonly options: FileLockOptions = defaultOptions
  ) {}

  async runExclusive<T>(label: string, task: () => Promise<T>): Promise<T> {
    const owner = await this.acquire(label);
    try {
      return await task();
    } finally {
      await this.release(owner, label);
    }
  }

  private async acquire(label: string): Promise<string> {
    const owner = `${process.pid}-${randomUUID()}`;
    const deadline = Date.now() + this.options.waitMs;

    while (true) {
      try {
        await mkdir(this.lockPath);
        await writeFile(
          this.ownerPath(),
          JSON.stringify({ owner, pid: process.pid, label, acquiredAt: new Date().toISOString() }, null, 2),
          "utf8"
        );
        logger.info({ label, lockPath: this.lockPath }, "Open lock acquired");
        return owner;
      } catch (error) {
        if (!isAlreadyExists(error)) {
          throw error;
        }

        if (await this.removeIfStale(label)) {
          continue;
        }

        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for open lock ${this.lockPath}`);
        }

        logger.warn({ label, lockPath: this.lockPath }, "Waiting for another open operation to finish");
        await sleep(this.options.pollMs);
      }
    }
  }

  private async removeIfStale(label: string): Promise<boolean> {
    try {
      const info = await stat(this.lockPath);
      if (Date.now() - info.mtimeMs < this.options.staleMs) {
        return false;
      }

      await rm(this.lockPath, { recursive: true, force: true });
      logger.warn({ label, lockPath: this.lockPath }, "Removed stale open lock");
      return true;
    } catch (error) {
      if (isNotFound(error)) {
        return true;
      }
      throw error;
    }
  }

  private async release(owner: string, label: string): Promise<void> {
    try {
      const raw = await readFile(this.ownerPath(), "utf8");
      const parsed = JSON.parse(raw) as { owner?: string };
      if (parsed.owner !== owner) {
        logger.warn({ label, lockPath: this.lockPath }, "Open lock owner changed before release");
        return;
      }
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }

    await rm(this.lockPath, { recursive: true, force: true });
    logger.info({ label, lockPath: this.lockPath }, "Open lock released");
  }

  private ownerPath(): string {
    return join(this.lockPath, "owner.json");
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
