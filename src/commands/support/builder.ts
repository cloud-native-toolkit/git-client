import {Argv} from 'yargs';
import {forCaCertFile} from './checks';
import {caCertAbsolutePath, loadFromEnv} from './middleware';

export const defaultBuilder = (yargs: Argv<any>) => {
  return yargs
    .option('caCert', {
      type: 'string',
      description: 'Name of the file containing the ca certificate for SSL connections. The value can also be provided in the `GIT_CA_CERT` environment variable.',
      demandOption: false
    })
    .middleware(loadFromEnv('caCert', 'GIT_CA_CERT'), true)
    .middleware(caCertAbsolutePath())
    .check(forCaCertFile())
}
