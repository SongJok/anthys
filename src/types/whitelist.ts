export type WhitelistStatus = 'pending' | 'approved' | 'rejected' | 'left';

export type WhitelistSource = 'directory' | 'dws' | 'auto' | 'manual';

/** 白名单条目：内部员工 staffId、姓名与授权状态 */
export interface WhitelistEntry {
  staffId: string;
  name: string;
  deptPath: string;
  status: WhitelistStatus;
  source: WhitelistSource;
  openDingTalkId: string | null;
  note: string;
  approvedBy: string | null;
  approvedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WhitelistStats {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  /** 通讯录同步后确认已离职的员工 */
  left: number;
  /** 最近一次通讯录同步时间（由 lastSeenAt 推导） */
  syncedAt: string | null;
}

export interface WhitelistQuery {
  status?: WhitelistStatus;
  query?: string;
  page?: number;
  pageSize?: number;
}

export interface WhitelistPage {
  items: WhitelistEntry[];
  total: number;
  page: number;
  pageSize: number;
  stats: WhitelistStats;
}

export interface WhitelistSyncResult {
  source: 'dingtalk-api' | 'dws';
  scanned: number;
  created: number;
  updated: number;
  unchanged: number;
  /** 本次被标记为已离职的员工数 */
  left: number;
  /** 因通讯录数量异常而未做离职判定的员工数 */
  skipped: number;
  warnings: string[];
  syncedAt: string;
}

export interface DirectoryUser {
  staffId: string;
  name: string;
  deptPath: string;
}

/** 通讯录来源：优先应用 API，授权范围不足时回退到 DWS 通讯录 */
export interface DirectorySource {
  readonly name: 'dingtalk-api' | 'dws';
  fetchUsers(): Promise<DirectoryUser[]>;
}

export interface WhitelistStore {
  get(staffId: string): Promise<WhitelistEntry | null>;
  findByOpenId(openId: string): Promise<WhitelistEntry | null>;
  list(query: WhitelistQuery): Promise<{ items: WhitelistEntry[]; total: number }>;
  stats(): Promise<WhitelistStats>;
  upsertDirectory(
    users: DirectoryUser[],
    source: WhitelistSource,
    options: { markAbsent: boolean },
  ): Promise<{
    created: number;
    updated: number;
    unchanged: number;
    left: number;
    skipped: number;
  }>;
  /** 当前认定为在职的通讯录条目数，用于判断某个来源的覆盖是否完整 */
  countTracked(): Promise<number>;
  registerPending(staffId: string, name: string): Promise<void>;
  setStatus(
    staffId: string,
    status: WhitelistStatus,
    actor: string,
    note?: string,
  ): Promise<WhitelistEntry | null>;
  setStatusBatch(
    staffIds: string[],
    status: WhitelistStatus,
    actor: string,
  ): Promise<number>;
  bindOpenId(staffId: string, openDingTalkId: string): Promise<void>;
}

export interface UserWhitelistAdminPort {
  list(query: WhitelistQuery): Promise<WhitelistPage>;
  stats(): Promise<WhitelistStats>;
  sync(): Promise<WhitelistSyncResult>;
  setStatus(
    staffId: string,
    status: WhitelistStatus,
    actor: string,
    note?: string,
  ): Promise<WhitelistEntry | null>;
  setStatusBatch(
    staffIds: string[],
    status: WhitelistStatus,
    actor: string,
  ): Promise<number>;
}
