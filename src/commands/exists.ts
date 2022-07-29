import {Arguments, Argv} from 'yargs';
import {Container} from 'typescript-ioc';
import {dump} from 'js-yaml';

import {apiFromUrl, ErrorType, GitApi, GitRepo, isGitError} from '../lib';
import {forAzureDevOpsProject, forCredentials} from './support/checks';
import {
  defaultOwnerToUsername,
  loadCredentialsFromFile,
  loadFromEnv,
  parseHostOrgProjectAndBranchFromUrl,
  repoNameToGitUrl
} from './support/middleware';
import {Logger, verboseLoggerFactory} from '../util/logger';
import {defaultBuilder} from './support/builder';
import {SSLConfig} from './support/model';

export const command = 'exists [gitUrl]'
export const desc = 'Checks if a hosted git repo exists';
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
  .option('output', {
    type: 'string',
    choices: ['json', 'yaml', 'text'],
    description: 'Print the output in the specified format. If not provided the information is printed in human readable text.',
    default: 'json'
  })
  .options('quiet', {
    type: 'boolean',
    alias: ['q'],
    description: 'Flag indicating JSON output should be suppressed.',
    default: false
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
export const handler =  async (argv: Arguments<ExistsArgs & {debug?: boolean, output?: 'json' | 'yaml' | 'text', quiet?: boolean}>) => {

  Container.bind(Logger).factory(verboseLoggerFactory(argv.debug))

  const credentials = {username: argv.username, password: argv.token, caCert: argv.caCert}

  try {
    const repoApi: GitApi = await apiFromUrl(argv.gitUrl, credentials)

    const repoInfo: GitRepo = await repoApi.getRepoInfo()

    if (!argv.quiet) {
      switch (argv.output) {
        case 'json':
          console.log(JSON.stringify(repoInfo, null, 2))
          break
        case 'yaml':
          console.log(dump(repoInfo))
          break
        default:
          console.log(`Repo found!`)
          console.log(`  Name:        ${repoInfo.name}`)
          console.log(`  Description: ${repoInfo.description}`)
          console.log(`  Main branch: ${repoInfo.default_branch}`)
          console.log(`  Is private:  ${repoInfo.is_private}`)
          console.log(`  Slug:        ${repoInfo.slug}`)
          console.log(`  Http url:    ${repoInfo.http_url}`)
      }
    }

    process.exit(0)
  } catch (err) {
    if (isGitError(err)) {
      if (!argv.quiet || err.type !== ErrorType.repoNotFound) {
        console.error(err.message)
      }
    } else if (argv.debug) {
      console.error('Error retrieving repo', err)
    } else {
      console.error('Error retrieving repo')
    }
    process.exit(1)
  }
}

interface ExistsArgs extends SSLConfig {
  gitUrl: string;
  username: string;
  token: string;
  host?: string;
  owner?: string;
  project?: string;
}
