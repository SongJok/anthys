/** 个人 DWS 身份：同意记录与独立 profile 绑定 */

export interface DwsIdentityRecord {
  staffId: string;
  consentVersion: number;
  consentedAt: string;
  scopes: string[];
  writeEnabled: boolean;
  /** 用户主动发送 /dws-consent read 后置为 true，写请求不再自动升级 */
  writeOptOut: boolean;
  homeDir: string;
  corpId: string | null;
  dwsUserId: string | null;
  profile: string | null;
  userName: string | null;
  corpName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DwsConsentInput {
  staffId: string;
  consentVersion: number;
  scopes: string[];
  consentedAt: string;
  homeDir: string;
  /** 仅首次插入时生效，已有记录沿用原写权限设置 */
  writeEnabled?: boolean;
  writeOptOut?: boolean;
}

export interface DwsWritePolicyInput {
  writeEnabled?: boolean;
  writeOptOut?: boolean;
}

export interface DwsBindingInput {
  staffId: string;
  corpId: string;
  dwsUserId: string;
  profile: string;
  userName?: string | null;
  corpName?: string | null;
}

export interface DwsIdentityStore {
  get(staffId: string): Promise<DwsIdentityRecord | null>;
  list(): Promise<DwsIdentityRecord[]>;
  upsertConsent(input: DwsConsentInput): Promise<DwsIdentityRecord>;
  setWritePolicy(
    staffId: string,
    input: DwsWritePolicyInput,
  ): Promise<DwsIdentityRecord>;
  bind(input: DwsBindingInput): Promise<DwsIdentityRecord>;
  unbind(staffId: string): Promise<void>;
  remove(staffId: string): Promise<boolean>;
}
