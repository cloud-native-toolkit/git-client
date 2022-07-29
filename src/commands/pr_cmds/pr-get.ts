import {Arguments, Argv} from 'yargs';
import {Container} from 'typescript-ioc';
import {dump} from 'js-yaml';

import {apiFromUrl, GetPullRequestOptions, GitApi, GitRepo, isGitError} from '../../lib';
import {
  defaultOwnerToUsername,
  loadCredentialsFromFile,
  loadFromEnv,
  parseHostOrgProjectAndBranchFromUrl,
  repoNameToGitUrl
} from '../support/middleware';
import {forAzureDevOpsProject, forCredentials} from '../support/checks';
import {Logger, verboseLoggerFactory} from '../../util/logger';
import {SSLConfig} from '../support/model';
import {defaultBuilder} from '../support/builder';

export const command = 'get [gitUrl]'
export const aliases = []
export const desc = 'Gets information about a pull request';
export const builder = (yargs: Argv<any>) => defaultBuilder(yargs)
  .positional('gitUrl', {
    type: 'string',
    description: 'The url of the repo that will be cloned',
    demandOption: true
  })
  .option('pullNumber', {
    type: 'number',
    description: ''
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
  .middleware(copySourceBranchToPullNumber(), true)
  .middleware(loadFromEnv('username', 'GIT_USERNAME'), true)
  .middleware(loadFromEnv('token', 'GIT_TOKEN'), true)
  .middleware(loadCredentialsFromFile(), true)
  .middleware(defaultOwnerToUsername(), true)
  .middleware(repoNameToGitUrl(), true)
  .check(forCredentials())
  .check(forAzureDevOpsProject())
export const handler =  async (argv: Arguments<GetPullRequestArgs & {debug: boolean, output: 'json' | 'yaml' | 'text'}>) => {

  Container.bind(Logger).factory(verboseLoggerFactory(argv.debug))

  const credentials = {username: argv.username, password: argv.token, caCert: argv.caCert}

  try {
    const repoApi: GitApi = await apiFromUrl(argv.gitUrl, credentials)

    const result = await repoApi.getPullRequest({
      pullNumber: argv.pullNumber
    })

    switch (argv.output) {
      case 'json':
        console.log(JSON.stringify(result, null, 2))
        break
      case 'yaml':
        console.log(dump(result))
        break
      default:
        console.log('Pull request found!')
        console.log(`  Pull number:   ${result.pullNumber}`)
        console.log(`  Source branch: ${result.sourceBranch}`)
        console.log(`  Target branch: ${result.targetBranch}`)
        console.log(`  Status:        ${result.status}`)
    }
  } catch (err) {
    let message = ''
    let type;
    if (isGitError(err)) {
      message = err.message
      type = err.type
    } else if (/Authentication failed/.test(err.message)) {
      message = err.message.replace('fatal: ', '')
    } else if (argv.debug) {
      message = 'Error getting pull request'
    }

    const result = {
      message,
      pullNumber: argv.pullNumber,
      errorType: type
    }

    if (argv.output === 'json') {
      console.log(JSON.stringify(result, null, 2))
    } else if (argv.output === 'yaml') {
      console.log(dump(result))
    } else {
      console.log(message)

      if (argv.debug) {
        console.log('Error: ', err)
      }
    }

    process.exit(1)
  }
}

interface GetPullRequestArgs extends SSLConfig {
  pullNumber: number;
  gitUrl: string;
  username: string;
  token: string;
}

const copySourceBranchToPullNumber = () => {
  return (yargs) => {
    const result: {pullNumber?: string} = {}

    result.pullNumber = yargs.pullNumber || yargs.sourceBranch

    return result
  }
}

const getTargetBranch = async (repoApi: GitApi, targetBranch: string): Promise<string> => {
  if (targetBranch) {
    return targetBranch
  }

  const repoInfo: GitRepo = await repoApi.getRepoInfo()

  return repoInfo.default_branch
}
