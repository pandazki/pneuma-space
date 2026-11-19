export class CloudError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'CloudError';
    this.status = status;
    this.code = code;
  }
}

export function invalid(message: string): never {
  throw new CloudError(400, 'invalid_input', message);
}

export function conflict(message: string): never {
  throw new CloudError(409, 'conflict', message);
}

export function forbidden(message = 'This action is not allowed.'): never {
  throw new CloudError(403, 'forbidden', message);
}

export function missing(): never {
  throw new CloudError(404, 'not_found', 'Application not found.');
}

export function quota(message: string): never {
  throw new CloudError(429, 'quota_exceeded', message);
}
