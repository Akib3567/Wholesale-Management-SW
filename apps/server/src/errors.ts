/** Application errors that map directly to HTTP responses. */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Not authenticated') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Not allowed') {
    super(403, 'FORBIDDEN', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(404, 'NOT_FOUND', message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, 'CONFLICT', message);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string) {
    super(400, 'BAD_REQUEST', message);
  }
}

/** Σdebit ≠ Σcredit — the one error LedgerService exists to make impossible to ignore. */
export class UnbalancedEntryError extends AppError {
  constructor(debitPaisa: number, creditPaisa: number) {
    super(
      400,
      'UNBALANCED_ENTRY',
      `Journal entry does not balance: debit ${debitPaisa} ≠ credit ${creditPaisa} (paisa)`,
    );
  }
}

export class InstallNotConfiguredError extends AppError {
  constructor() {
    super(409, 'INSTALL_NOT_CONFIGURED', 'Branch identity has not been set up on this install');
  }
}
