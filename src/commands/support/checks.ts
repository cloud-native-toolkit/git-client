import {fileExists, fileExistsSync} from '../../util/file-util';
import {SSLConfig} from './model';

export const forCredentials = () => {
  return yargs => {
    if (!yargs.username) {
      throw new Error('Git username is required. The value can be provided in the `username` argument or `GIT_USERNAME` environment variable')
    }
    if (!yargs.token) {
      throw new Error('Git token is required. The value can be provided in the `token` argument or `GIT_TOKEN` environment variable')
    }

    return true
  }
}

export const forAzureDevOpsProject = () => {
  return yargs => {
    if (yargs.host === 'dev.azure.com' && !yargs.project) {
      throw new Error('Git project is required for Azure DevOps repositories.')
    }

    return true
  }
}

export const forCaCertFile = () => {
  return (yargs: SSLConfig) => {
    if (yargs.caCert && !fileExistsSync(yargs.caCert)) {
      throw new Error(`Unable to find caFile: ${yargs.caCert}`)
    }

    return true
  }
}
