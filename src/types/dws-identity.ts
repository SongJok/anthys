/** 个人 DWS 身份：同意记录与独立 profile 绑定 */

export interface DwsIdentityRecord {
  staffId: string;
  consentVersion: number;
  consentedAt: string;
  scopes: string[];
  writeEnabled: boolean;
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
  setWriteEnabled(staffId: string, enabled: boolean): Promise<DwsIdentityRecord>;
  bind(input: DwsBindingInput): Promise<DwsIdentityRecord>;
  unbind(staffId: string): Promise<void>;
  remove(staffId: string): Promise<boolean>;
}
