import { and, asc, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { pluginVersions, plugins } from '../db/pluginSchema.js';
import type {
  PluginManifest,
  PluginRecord,
  PluginStatus,
  PluginVersionRecord,
  PluginVersionStatus,
} from '../types/skills-plugins-projects.js';

export interface PluginUpdate {
  name?: string;
  activeVersion?: string;
  status?: PluginStatus;
  manifest?: PluginManifest;
  installedBy?: string;
  lastError?: string;
}

export interface PluginVersionUpdate {
  manifest?: PluginManifest;
  dir?: string;
  checksum?: string;
  status?: PluginVersionStatus;
}

export interface PluginStore {
  listPlugins(): Promise<PluginRecord[]>;
  getPlugin(id: string): Promise<PluginRecord | null>;
  insertPlugin(record: PluginRecord): Promise<void>;
  updatePlugin(id: string, patch: PluginUpdate): Promise<void>;
  deletePlugin(id: string): Promise<void>;
  listVersions(pluginId: string): Promise<PluginVersionRecord[]>;
  getVersion(
    pluginId: string,
    version: string,
  ): Promise<PluginVersionRecord | null>;
  insertVersion(record: PluginVersionRecord): Promise<void>;
  updateVersion(
    pluginId: string,
    version: string,
    patch: PluginVersionUpdate,
  ): Promise<void>;
  deleteVersion(pluginId: string, version: string): Promise<void>;
}

function rowToPlugin(row: typeof plugins.$inferSelect): PluginRecord {
  return {
    id: row.id,
    name: row.name,
    activeVersion: row.activeVersion,
    status: row.status as PluginStatus,
    manifest: row.manifest,
    installedBy: row.installedBy,
    lastError: row.lastError,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function rowToVersion(
  row: typeof pluginVersions.$inferSelect,
): PluginVersionRecord {
  return {
    pluginId: row.pluginId,
    version: row.version,
    manifest: row.manifest,
    dir: row.dir,
    checksum: row.checksum,
    status: row.status as PluginVersionStatus,
    installedAt: row.installedAt.getTime(),
  };
}

export class DrizzlePluginStore implements PluginStore {
  constructor(private readonly db: Database) {}

  public async listPlugins(): Promise<PluginRecord[]> {
    const rows = await this.db
      .select()
      .from(plugins)
      .orderBy(asc(plugins.name), asc(plugins.id));
    return rows.map(rowToPlugin);
  }

  public async getPlugin(id: string): Promise<PluginRecord | null> {
    const rows = await this.db
      .select()
      .from(plugins)
      .where(eq(plugins.id, id))
      .limit(1);
    return rows[0] ? rowToPlugin(rows[0]) : null;
  }

  public async insertPlugin(record: PluginRecord): Promise<void> {
    await this.db.insert(plugins).values({
      id: record.id,
      name: record.name,
      activeVersion: record.activeVersion,
      status: record.status,
      manifest: record.manifest,
      installedBy: record.installedBy,
      lastError: record.lastError,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
    });
  }

  public async updatePlugin(id: string, patch: PluginUpdate): Promise<void> {
    const values: Partial<typeof plugins.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.activeVersion !== undefined) {
      values.activeVersion = patch.activeVersion;
    }
    if (patch.status !== undefined) values.status = patch.status;
    if (patch.manifest !== undefined) values.manifest = patch.manifest;
    if (patch.installedBy !== undefined) values.installedBy = patch.installedBy;
    if (patch.lastError !== undefined) values.lastError = patch.lastError;
    await this.db.update(plugins).set(values).where(eq(plugins.id, id));
  }

  public async deletePlugin(id: string): Promise<void> {
    await this.db.delete(pluginVersions).where(eq(pluginVersions.pluginId, id));
    await this.db.delete(plugins).where(eq(plugins.id, id));
  }

  public async listVersions(pluginId: string): Promise<PluginVersionRecord[]> {
    const rows = await this.db
      .select()
      .from(pluginVersions)
      .where(eq(pluginVersions.pluginId, pluginId))
      .orderBy(desc(pluginVersions.installedAt));
    return rows.map(rowToVersion);
  }

  public async getVersion(
    pluginId: string,
    version: string,
  ): Promise<PluginVersionRecord | null> {
    const rows = await this.db
      .select()
      .from(pluginVersions)
      .where(
        and(
          eq(pluginVersions.pluginId, pluginId),
          eq(pluginVersions.version, version),
        ),
      )
      .limit(1);
    return rows[0] ? rowToVersion(rows[0]) : null;
  }

  public async insertVersion(record: PluginVersionRecord): Promise<void> {
    await this.db.insert(pluginVersions).values({
      pluginId: record.pluginId,
      version: record.version,
      manifest: record.manifest,
      dir: record.dir,
      checksum: record.checksum,
      status: record.status,
      installedAt: new Date(record.installedAt),
    });
  }

  public async updateVersion(
    pluginId: string,
    version: string,
    patch: PluginVersionUpdate,
  ): Promise<void> {
    const values: Partial<typeof pluginVersions.$inferInsert> = {};
    if (patch.manifest !== undefined) values.manifest = patch.manifest;
    if (patch.dir !== undefined) values.dir = patch.dir;
    if (patch.checksum !== undefined) values.checksum = patch.checksum;
    if (patch.status !== undefined) values.status = patch.status;
    if (Object.keys(values).length === 0) return;
    await this.db
      .update(pluginVersions)
      .set(values)
      .where(
        and(
          eq(pluginVersions.pluginId, pluginId),
          eq(pluginVersions.version, version),
        ),
      );
  }

  public async deleteVersion(
    pluginId: string,
    version: string,
  ): Promise<void> {
    await this.db
      .delete(pluginVersions)
      .where(
        and(
          eq(pluginVersions.pluginId, pluginId),
          eq(pluginVersions.version, version),
        ),
      );
  }
}
