export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class AttemptCancelled extends Error {
  constructor() {
    super('This attempt was stopped.');
  }
}

export class ProviderFailure extends Error {
  constructor(
    message: string,
    readonly uncertain = false,
  ) {
    super(message);
  }
}
