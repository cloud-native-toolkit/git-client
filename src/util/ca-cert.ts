import {promises} from 'fs';

export const loadCaCert = async (caCert: {cert: string, certFile} | string): Promise<{cert: string, certFile: string} | undefined> => {
  if (!caCert) {
    return
  }

  if (typeof caCert !== 'string') {
    return caCert
  }

  const certFile = caCert

  const contents = await promises.readFile(certFile)

  return {cert: contents.toString(), certFile}
}
