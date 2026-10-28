export type TokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
};

export type SessionPayload = {
  unionId: string;
  clientId: string;
  // AP1: "setup" = authenticated but restricted until admin 2FA
  // enrollment completes (only issued when admin_2fa_required is on
  // and the admin has not enrolled yet). Absent = full session.
  scope?: "setup";
};

export type UserProfile = {
  user_id: string;
  name: string;
  avatar_url: string;
};
