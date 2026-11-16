// errors.mjs — the error that is meant for the user: its message is the whole explanation, no stack.

export class UserError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = "UserError";
    this.user = true;
    if (status) this.status = status;
  }
}
