import { MongoClient, type Db } from 'mongodb';

export interface Storage {
  readonly client: MongoClient;
  readonly db: Db;
  /** Next to db in the same replica set, so one transaction can move between the two. */
  readonly archive: Db;
  close(): Promise<void>;
}

export interface ConnectOptions {
  /** Full connection string. The service never assembles a host of its own. */
  readonly uri: string;
  readonly database: string;
  readonly serverSelectionTimeoutMs?: number;
}

/** The archive next to a database: a second one on the same server, so one transaction spans both. */
export function archiveOf(db: Db): Db {
  return db.client.db(`${db.databaseName}_archive`);
}

/** Opens the single connection pool and pings it, so a wrong address fails at startup. */
export async function connect(options: ConnectOptions): Promise<Storage> {
  const client = new MongoClient(options.uri, {
    serverSelectionTimeoutMS: options.serverSelectionTimeoutMs ?? 5_000,
  });

  try {
    await client.connect();
    const db = client.db(options.database);
    await db.command({ ping: 1 });
    return {
      client,
      db,
      // MongoDB creates it with its first collection.
      archive: archiveOf(db),
      close: async () => {
        await client.close();
      },
    };
  } catch (cause) {
    await client.close().catch(() => undefined);
    throw new Error(`cannot reach the database "${options.database}"`, { cause });
  }
}
