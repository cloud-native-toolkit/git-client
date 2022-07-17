import {Arguments, Argv} from 'yargs';
import {Container} from 'typescript-ioc';
import {dump} from 'js-yaml';

import {apiFromUrl, GitApi, GitRepo, isGitError} from '../../lib';
import {
  defaultOwnerToUsername,
  loadCredentialsFromFile,
  loadFromEnv,
  parseHostOrgProjectAndBranchFromUrl,
  repoNameToGitUrl
} from '../support/middleware';
import {forAzureDevOpsProject, forCredentials} from '../support/checks';
import {Logger, verboseLoggerFactory} from '../../util/logger';


export const forSourceBranch = () => {
  return yargs => {
    if (!yargs.sourceBranch) {
      throw new Error('Source branch for pull request is required. The value can be provided in the `sourceBranch` argument or on the end of the url with a hash (e.g. repo#sourceBranch)')
    }

    return true
  }
}

export const command = 'create [gitUrl]'
export const aliases = []
export const desc = 'Creates a pull request against hosted git repo';
export const builder = (yargs: Argv<any>) => yargs
  .positional('gitUrl', {
    type: 'string',
    description: 'The url of the repo that will be cloned',
    demandOption: true
  })
  .option('sourceBranch', {
    type: 'string',
    description: 'The source branch for the pull request.',
    demandOption: true,
  })
  .option('targetBranch', {
    type: 'string',
    description: 'The target branch for the pull request. If left blank the value will use the default branch.'
  })
  .option('title', {
    type: 'string',
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
  .middleware(loadFromEnv('username', 'GIT_USERNAME'), true)
  .middleware(loadFromEnv('token', 'GIT_TOKEN'), true)
  .middleware(loadCredentialsFromFile(), true)
  .middleware(defaultOwnerToUsername(), true)
  .middleware(repoNameToGitUrl(), true)
  .check(forCredentials())
  .check(forSourceBranch())
  .check(forAzureDevOpsProject())
export const handler =  async (argv: Arguments<CreatePullRequestArgs & {debug: boolean, output: 'json' | 'yaml' | 'text'}>) => {

  Container.bind(Logger).factory(verboseLoggerFactory(argv.debug))

  const credentials = {username: argv.username, password: argv.token}

  try {
    const repoApi: GitApi = await apiFromUrl(argv.gitUrl, credentials)

    const type = repoApi.getConfig().type
    const owner = repoApi.getConfig().owner
    const repo = repoApi.getConfig().repo

    const targetBranch: string = await getTargetBranch(repoApi, argv.targetBranch)

    if (argv.output === 'text') {
      console.log(`Creating pull request in ${type} repo (${owner}/${repo}) from ${argv.sourceBranch} to ${targetBranch}`)
    }

    const title = argv.title || `Merge ${argv.sourceBranch} into ${targetBranch}`

    const result = await repoApi.createPullRequest({
      sourceBranch: argv.sourceBranch,
      targetBranch,
      title,
      rateLimit: false
    })

    switch (argv.output) {
      case 'json':
        console.log(JSON.stringify(result, null, 2))
        break
      case 'yaml':
        console.log(dump(result))
        break
      default:
        console.log('Pull request created!')
        console.log(`  Pull number:   ${result.pullNumber}`)
        console.log(`  Source branch: ${result.sourceBranch}`)
        console.log(`  Target branch: ${result.targetBranch}`)
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
      message = 'Error creating pull request'
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

interface CreatePullRequestArgs {
  gitUrl: string;
  sourceBranch: string;
  targetBranch?: string;
  title?: string;
  username: string;
  token: string;
}

const getTargetBranch = async (repoApi: GitApi, targetBranch: string): Promise<string> => {
  if (targetBranch) {
    return targetBranch
  }

  const repoInfo: GitRepo = await repoApi.getRepoInfo()

  return repoInfo.default_branch
}
