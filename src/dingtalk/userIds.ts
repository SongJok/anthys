/**
 * 外部群成员的 Stream 消息没有 senderStaffId，只能退回加密的 senderId（`$:LWCP_v1:$…`）。
 * 这种 id 既不能当 staffId 投递卡片，也不能放进 atUserIds，否则钉钉返回 400。
 */
export function isStaffUserId(value: string | undefined): boolean {
  const id = value?.trim();
  return !!id && !id.startsWith('$:');
}
