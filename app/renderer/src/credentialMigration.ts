export const CREDENTIAL_REENTRY_NOTICE_STORAGE_KEY = "agent-ppt.credentials-reentry-notice.v1";

export function markCredentialReentryRequired(): void {
  try {
    window.localStorage.setItem(CREDENTIAL_REENTRY_NOTICE_STORAGE_KEY, "1");
  } catch {
    /* The notice is best-effort; secret removal does not depend on it. */
  }
}

export function consumeCredentialReentryNotice(): boolean {
  try {
    const required = window.localStorage.getItem(CREDENTIAL_REENTRY_NOTICE_STORAGE_KEY) === "1";
    if (required) window.localStorage.removeItem(CREDENTIAL_REENTRY_NOTICE_STORAGE_KEY);
    return required;
  } catch {
    return false;
  }
}
