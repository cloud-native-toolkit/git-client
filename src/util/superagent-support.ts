import {Request} from 'superagent';

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
  return error && !!((error as ResponseError).status) && !!((error as ResponseError).response);
}

export const applyCert = (req: Request, caCert?: {cert: string}): Request => {
  if (caCert) {
    // TODO why does CA Cert not work!?!?!
    return req.ca(caCert.cert).disableTLSCerts()
  }

  return req
}
