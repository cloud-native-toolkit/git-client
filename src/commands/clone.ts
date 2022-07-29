import {Arguments, Argv} from 'yargs';
import {Container} from 'typescript-ioc';

import {
  defaultOwnerToUsername,
  loadCredentialsFromFile,
  loadFromEnv,
  parseHostOrgProjectAndBranchFromUrl, repoNameToGitUrl
} from './support/middleware';
import {forAzureDevOpsProject, forCredentials} from './support/checks';
import {SSLConfig} from './support/model';
import {defaultBuilder} from './support/builder';
import {apiFromUrl, GitApi, isGitError} from '../lib';
import {loadCaCert} from '../util/ca-cert';
import {Logger, verboseLoggerFactory} from '../util/logger';

export const command = 'clone [gitUrl] [location]'
export const aliases = []
export const desc = 'Clones a hosted git repo';
export const builder = (yargs: Argv<any>) => defaultBuilder(yargs)
  .positional('gitUrl', {
    type: 'string',
    description: 'The url of the repo that will be cloned',
    demandOption: true
  })
  .positional('location', {
    type: 'string',
    description: 'The directory where the repository should be cloned',
    demandOption: false
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
  .option('configName', {
    type: 'string',
    description: 'The name for the git config',
    default: 'Cloud-Native Toolkit'
  })
  .option('configEmail', {
    type: 'string',
    description: 'The email for the git config',
    default: 'cloudnativetoolkit@gmail.com'
  })
  .options('debug', {
    type: 'boolean',
    description: 'Display debug information'
  })
  .middleware(parseHostOrgProjectAndBranchFromUrl(), true)
  .middleware(loadFromEnv('username', 'GIT_USERNAME'), true)
  .middleware(loadFromEnv('token', 'GIT_TOKEN'), true)
  .middleware(loadCredentialsFromFile(), true)
  .middleware(defaultOwnerToUsername(), true)
  .middleware(repoNameToGitUrl(), true)
  .check(forCredentials())
  .check(forAzureDevOpsProject())
export const handler =  async (argv: Arguments<CloneArgs & {debug: boolean}>) => {

  Container.bind(Logger).factory(verboseLoggerFactory(argv.debug))

  const credentials = {username: argv.username, password: argv.token, caCert: argv.caCert}

  try {
    const repoApi: GitApi = await apiFromUrl(argv.gitUrl, credentials)

    const type = repoApi.getConfig().type
    const repo = repoApi.getConfig().repo
    console.log(`Cloning ${type} repo: ${repo}`)

    const location: string = argv.location || repoApi.getConfig().url.replace(new RegExp('.*/(.+)'), '$1')

    const caCert: {cert: string, certFile: string} | undefined = await loadCaCert(argv.caCert)
    const config = caCert ? {'http.sslCAInfo': caCert.certFile} : {}

    await repoApi.clone(location, {userConfig: {name: argv.configName, email: argv.configEmail}, config})

    console.log(`  Repo cloned into: ${location}`)
  } catch (err) {
    if (isGitError(err)) {
      console.error(err.message)
    } else if (/Authentication failed/.test(err.message)) {
      console.error(err.message.replace('fatal: ', ''))
    } else if (argv.debug) {
      console.error('Error cloning repo', err)
    } else {
      console.error('Error cloning repo')
    }
    process.exit(1)
  }
}

interface CloneArgs extends SSLConfig {
  gitUrl: string;
  location?: string;
  username: string;
  token: string;
  configEmail: string;
  configName: string;
}
