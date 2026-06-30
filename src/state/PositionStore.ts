import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ExitReason,
  ManagedPositionState,
  OutOfRangeDirection,
  PositionStatus,
  ProfitSnapshot
} from "../types.js";

interface PositionStoreFile {
  positions: ManagedPositionState[];
}

export class PositionStore {
  private positions = new Map<string, ManagedPositionState>();
  private loaded = false;
  private flushQueue = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as PositionStoreFile;
      for (const position of parsed.positions ?? []) {
        this.positions.set(position.id, position);
      }
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }

    this.loaded = true;
  }

  async reload(): Promise<void> {
    this.positions.clear();
    this.loaded = false;
    await this.load();
  }

  list(): ManagedPositionState[] {
    return [...this.positions.values()];
  }

  listActive(): ManagedPositionState[] {
    return this.list().filter((position) => position.status === "OPEN" || position.status === "EXITING");
  }

  get(id: string): ManagedPositionState | undefined {
    return this.positions.get(id);
  }

  async upsert(position: ManagedPositionState): Promise<void> {
    this.positions.set(position.id, position);
    await this.flush();
  }

  async setStatus(id: string, status: PositionStatus, exitReason?: ExitReason): Promise<void> {
    const position = this.require(id);
    this.positions.set(id, {
      ...position,
      status,
      ...(exitReason ? { exitReason } : {})
    });
    await this.flush();
  }

  async recordSnapshot(id: string, snapshot: ProfitSnapshot): Promise<void> {
    const position = this.require(id);
    const { lastError: _lastError, ...positionWithoutLastError } = position;
    this.positions.set(id, {
      ...positionWithoutLastError,
      lastSnapshot: snapshot,
      errorCount: 0
    });
    await this.flush();
  }

  async recordOutOfRange(id: string, direction: OutOfRangeDirection, since: string): Promise<void> {
    const position = this.require(id);
    this.positions.set(id, {
      ...position,
      outOfRangeDirection: direction,
      outOfRangeSince: since
    });
    await this.flush();
  }

  async clearOutOfRange(id: string): Promise<void> {
    const position = this.require(id);
    const { outOfRangeDirection: _direction, outOfRangeSince: _since, ...positionInRange } = position;
    this.positions.set(id, positionInRange);
    await this.flush();
  }

  async recordError(id: string, message: string): Promise<void> {
    const position = this.require(id);
    this.positions.set(id, {
      ...position,
      errorCount: position.errorCount + 1,
      lastError: message
    });
    await this.flush();
  }

  async recordClosed(id: string, txs: string[], closedAt: string, exitReason?: ExitReason): Promise<void> {
    const position = this.require(id);
    const {
      lastError: _lastError,
      outOfRangeDirection: _direction,
      outOfRangeSince: _since,
      ...positionWithoutTransientState
    } = position;
    this.positions.set(id, {
      ...positionWithoutTransientState,
      status: "CLOSED",
      ...(exitReason ? { exitReason } : {}),
      errorCount: 0,
      exitTxs: txs,
      closedAt
    });
    await this.flush();
  }

  private require(id: string): ManagedPositionState {
    const position = this.positions.get(id);
    if (!position) {
      throw new Error(`Position ${id} is not tracked`);
    }
    return position;
  }

  private async flush(): Promise<void> {
    const pending = this.flushQueue.then(() => this.writeSnapshot());
    this.flushQueue = pending.catch(() => undefined);
    return pending;
  }

  private async writeSnapshot(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const payload: PositionStoreFile = {
      positions: [...this.positions.values()].sort((a, b) => a.openedAt.localeCompare(b.openedAt))
    };
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(tmp, this.filePath);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
