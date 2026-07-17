export const CODES = ["USER_NOT_FOUND", "USER_INVALID", "USER_CONFLICT", "STORE_UNAVAILABLE"];

export class AppError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}
