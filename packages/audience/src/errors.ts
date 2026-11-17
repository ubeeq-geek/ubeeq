export class AudienceError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
    this.name = 'AudienceError';
  }
}

export class MailingListError extends AudienceError {
  constructor(status: number, message: string, code?: string) {
    super(status, message, code);
    this.name = 'MailingListError';
  }
}

export class PhotographyError extends AudienceError {
  constructor(status: number, message: string, code?: string) {
    super(status, message, code);
    this.name = 'PhotographyError';
  }
}
