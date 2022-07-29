import {Argv} from 'yargs';
import {forCaCertFile} from './checks';
import {caCertAbsolutePath} from './middleware';

export const defaultBuilder = (yargs: Argv<any>) => {
  return yargs
    .option('caCert', {
      type: 'string',
      description: 'Name of the file containing the ca certificate for SSL connections',
      demandOption: false
    })
    .middleware(caCertAbsolutePath())
    .check(forCaCertFile())
}
