import {existsSync, readFileSync} from 'fs'
import {join} from 'path'
import {homedir} from 'os'
import {load} from 'js-yaml'
import {Container} from 'typescript-ioc';
import first from '../../util/first';
import {Optional} from 'optional-typescript';

export const loadFromEnv = (name: string, envName: string) => {
  return yargs => {
    const result = {}

    if (!yargs[name]) {
      result[name] = process.env[envName]
    }

    return result
  }
}

export const defaultOwnerToUsername = () => {
  return yargs => {
    if (!yargs.owner) {
      return {owner: yargs.username}
    }

    return {}
  }
}

interface GitCredential {
  host: string
  username: string
  token: string
}

interface GitConfig {
  credentials: GitCredential[]
}

export const loadCredentialsFromFile = () => {
  return yargs => {

    if (yargs.username && yargs.token) {
      return {}
    }

    if (!yargs.host) {
      console.log('Host not set!!!')
      return {}
    }

    console.log('Loading config for host: '  + yargs.host)
    try {
      const configPath = join(homedir(), '.gitu-config')
      if (existsSync(configPath)) {
        const contents = readFileSync(configPath)

        const config = load(contents.toString()) as GitConfig
        const credential: Optional<GitCredential> = first((config.credentials || []).filter(config => config.host === yargs.host))

        return credential
          .map(cred => ({username: cred.username, token: cred.token}))
          .valueOr({} as any)
      }
    } catch (err) {
      // ignore error
    }

    return {}
  }
}

export const repoNameToGitUrl = () => {
  return yargs => {
    if (!/^https?/.test(yargs.gitUrl) && ~/^git@/.test(yargs.gitUrl) && !!yargs.host) {
      if (yargs.host === 'dev.azure.com') {
        return {gitUrl: `https://${yargs.host}/${yargs.owner}/${yargs.project}/_git/${yargs.gitUrl}`}
      } else {
        return {gitUrl: `https://${yargs.host}/${yargs.owner}/${yargs.gitUrl}`}
      }
    }

    return {}
  }
}

export const parseHostOrgAndProjectFromUrl = () => {
  return yargs => {
    if (!yargs.gitUrl) {
      return {}
    }

    const regex = new RegExp('https?://([^/]+)/([^/]+)/(.*)')

    if (regex.test(yargs.gitUrl)) {
      const result = regex.exec(yargs.gitUrl)

      const host = result[1].includes('@') ? result[1].split('@')[1] : result[1]
      const owner = result[2]
      const remainder = result[3]

      if (host.toLowerCase() === 'dev.azure.com') {
        const azureRegEx = new RegExp('([^/]+)/_git/([^/]+)')

        const project = azureRegEx.test(remainder) ? azureRegEx.exec(remainder)[1] : remainder

        return {
          host,
          owner,
          project
        }
      }

      return {
        host,
        owner
      }
    }

    return {}
  }
}
