import mongoose, { type ClientSession } from "mongoose";

let supported: Promise<boolean> | null = null;

/**
 * Multi-document transactions need a replica set (e.g. Atlas) or a sharded cluster.
 * A standalone MongoDB rejects them outright, so detect once and adapt.
 */
export function transactionsSupported(): Promise<boolean> {
  supported ??= (async () => {
    try {
      const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
      return Boolean(hello.setName) || hello.msg === "isdbgrid";
    } catch {
      return false;
    }
  })();
  return supported;
}

export type Tx = {
  /** Pass as `{ session }` to queries; undefined when running without a transaction. */
  session: ClientSession | undefined;
  commit(): Promise<void>;
  abort(): Promise<void>;
  end(): void;
};

/**
 * Starts a transaction when the database supports one; otherwise returns a no-op so the
 * same code runs as plain writes. Without a transaction, writes aren't rolled back on
 * error — callers keep each step safe on its own (status-guarded updates).
 */
export async function beginTransaction(): Promise<Tx> {
  if (!(await transactionsSupported())) {
    return { session: undefined, commit: async () => {}, abort: async () => {}, end: () => {} };
  }
  const session = await mongoose.startSession();
  session.startTransaction();
  return {
    session,
    commit: () => session.commitTransaction(),
    abort: async () => {
      if (session.inTransaction()) await session.abortTransaction();
    },
    end: () => void session.endSession(),
  };
}

/** For tests: forget the cached capability check after reconnecting. */
export function resetTransactionSupportCache() {
  supported = null;
}
