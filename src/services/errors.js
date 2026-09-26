// An error with an HTTP status and a stable code for the client.
class AppError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

module.exports = { AppError };
