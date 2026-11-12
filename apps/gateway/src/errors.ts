/** A request the gateway understands but will not carry out. The server turns it into an HTTP answer. */
export class RequestError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
    readonly reasons: string[] = [],
  ) {
    super(message);
    this.name = 'RequestError';
  }
}
