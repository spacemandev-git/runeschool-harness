/** Compact wallet address suitable for display without exposing it as an entity's full name. */
export function shortPublicKey(publicKey: string): string {
  return publicKey.length <= 12
    ? publicKey
    : `${publicKey.slice(0, 4)}…${publicKey.slice(-4)}`;
}

/**
 * Wallets that hold master-admin authority on every server: their signed-in session may perform
 * any instance-admin action (including `DELETE /instances/:id`) without the per-instance admin
 * token. The server may extend this list at runtime via `AISCAPE_MASTER_WALLETS`.
 */
export const MASTER_ADMIN_WALLETS: readonly string[] = [
  'GsvY6rPFaipQ1qsACYFtQu7F9n3JxzBXFw8DDFnMkRpb'
];

export function isMasterAdminWallet(publicKey: string | undefined): boolean {
  return publicKey !== undefined && MASTER_ADMIN_WALLETS.includes(publicKey);
}
