import {Arguments, Argv} from 'yargs';
import {Container} from 'typescript-ioc';
import {dump} from 'js-yaml';

import {apiFromPartialConfig, apiFromUrl, GitApi, isGitError} from '../lib';
import {
  defaultOwnerToUsername,
  loadCredentialsFromFile,
  loadFromEnv,
  parseHostOrgProjectAndBranchFromUrl, repoNameToGitUrl
} from './support/middleware';
import {forAzureDevOpsProject, forCredentials} from './support/checks';
import {Logger, verboseLoggerFactory} from '../util/logger';
import {SSLConfig} from './support/model';
import {defaultBuilder} from './support/builder';

export const command = 'list [gitUrl]'
export const aliases = []
export const desc = 'Lists the hosted git repos for the org or user';
export const builder = (yargs: Argv<any>) => defaultBuilder(yargs)
  .positional('gitUrl', {
    type: 'string',
    description: 'The git url of the org or another repo in the same org. Either gitUrl OR host and owner must be provided.'
  })
  .option('host', {
    type: 'string',
    alias: ['h'],
    description: 'The host of the git server for the repo. The value can be provided as a `GIT_HOST` environment variable.'
  })
  .option('owner', {
    type: 'string',
    alias: ['o'],
    description: 'The owner/org for the git repo on the git server. If not provided the value will default to the `username` value.'
  })
  .option('project', {
    type: 'string',
    alias: ['p'],
    description: 'The project within the organization where the repository will be provisioned. The value can be provided as a `GIT_PROJECT` environment variable. (Primarily for Azure DevOps git repositories.)'
  })
  .option('username', {
    type: 'string',
    alias: ['u'],
    description: 'The username used to create the git repository. The value can also be provided via the `GIT_USERNAME` environment variable.'
  })
  .option('token', {
    type: 'string',
    description: 'The token/password used to authenticate the user to the git server. The value can also be provided via the GIT_TOKEN environment variable.',
  })
  .option('output', {
    type: 'string',
    choices: ['json', 'yaml', 'text'],
    description: 'Print the output in the specified format. If not provided the information is printed in human readable text.',
    default: 'text'
  })
  .options('debug', {
    type: 'boolean',
    description: 'Display debug information'
  })
  .middleware(parseHostOrgProjectAndBranchFromUrl(), true)
  .middleware(loadFromEnv('host', 'GIT_HOST'), true)
  .middleware(loadFromEnv('project', 'GIT_PROJECT'), true)
  .middleware(loadFromEnv('username', 'GIT_USERNAME'), true)
  .middleware(loadFromEnv('token', 'GIT_TOKEN'), true)
  .middleware(loadCredentialsFromFile(), true)
  .middleware(defaultOwnerToUsername(), true)
  .middleware(repoNameToGitUrl(), true)
  .check(forAzureDevOpsProject())
  .check(forCredentials())
export const handler =  async (argv: Arguments<ListArgs & {debug: boolean, output: 'json' | 'yaml' | 'text'}>) => {

  Container.bind(Logger).factory(verboseLoggerFactory(argv.debug))

  const credentials = {username: argv.username, password: argv.token, caCert: argv.caCert}

  try {
    const orgApi: GitApi = argv.gitUrl
      ? await apiFromUrl(argv.gitUrl, credentials)
      : await apiFromPartialConfig({host: argv.host, org: argv.owner}, credentials)

    const repos: string[] = await orgApi.listRepos()

    switch (argv.output) {
      case 'json':
        console.log(JSON.stringify({repos}, null, 2))
        break
      case 'yaml':
        console.log(dump({repos}))
        break;
      default:
        repos.forEach(repo => console.log(repo))
    }
  } catch (err) {
    if (isGitError(err)) {
      console.error(err.message)
    } else if (argv.debug) {
      console.error('Error listing repos', err)
    } else {
      console.error('Error listing repos')
    }
    process.exit(1)
  }
}

interface ListArgs extends SSLConfig {
  gitUrl?: string;
  host?: string;
  owner?: string;
  username: string;
  token: string;
}
