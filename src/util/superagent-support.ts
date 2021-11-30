
export interface ResponseError extends Error {
  status: number;
  response: {
    req: object;
    header: object;
    status: number;
    statusCode: number;
    text: string;
    body?: any;
  }
}

export function isResponseError(error: Error): error is ResponseError {
  return error && !!((error as ResponseError).status);
}
