import config from './jest.config'
import {config as envConfig} from 'dotenv'

envConfig()

config.testRegex = "\\.xspec\\.ts$"

export default config;
