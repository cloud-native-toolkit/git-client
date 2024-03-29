import {Arguments, Argv} from 'yargs';
import {apiFromUrl, GitApi, isGitError} from '../lib';
import {
  defaultOwnerToUsername,
  loadCredentialsFromFile,
  loadFromEnv,
  parseHostOrgProjectAndBranchFromUrl,
  repoNameToGitUrl
} from './support/middleware';
import {forAzureDevOpsProject, forCredentials} from './support/checks';
import {Container} from 'typescript-ioc';
import {Logger, verboseLoggerFactory} from '../util/logger';
import {defaultBuilder} from './support/builder';
import {SSLConfig} from './support/model';

export const command = 'delete [gitUrl]'
export const desc = 'Deletes a hosted git repo';
export const builder = (yargs: Argv<any>) => defaultBuilder(yargs)
  .positional('gitUrl', {
    type: 'string',
    description: 'The git url of the git repository that will be deleted',
    demandOption: true
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
    description: 'The username used to create the git repository. The value can also be provided via the `GIT_USERNAME` environment variable.',
  })
  .option('token', {
    type: 'string',
    description: 'The token/password used to authenticate the user to the git server. The value can also be provided via the GIT_TOKEN environment variable.',
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
export const handler =  async (argv: Arguments<DeleteArgs & {debug: boolean}>) => {

  Container.bind(Logger).factory(verboseLoggerFactory(argv.debug))

  const credentials = {username: argv.username, password: argv.token, caCert: argv.caCert}

  try {
    const repoApi: GitApi = await apiFromUrl(argv.gitUrl, credentials)
    console.log(`Deleting repo: ${argv.gitUrl}`)

    await repoApi.deleteRepo()

    console.log(`  Repo deleted: ${argv.gitUrl}`)
  } catch (err) {
    if (isGitError(err)) {
      console.error(err.message)
    } else if (argv.debug) {
      console.error('Error deleting repo', err)
    } else {
      console.error('Error deleting repo')
    }
    process.exit(1)
  }
}

interface DeleteArgs extends SSLConfig {
  gitUrl: string;
  username: string;
  token: string;
  host?: string;
  owner?: string;
  project?: string;
}
