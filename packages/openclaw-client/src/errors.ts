export class OpenClawClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class SessionConflictError extends OpenClawClientError {
  readonly code = "session_conflict";

  constructor(readonly activeSessionId: string | null) {
    super("targetSessionId does not match the current activeSessionId");
  }
}
