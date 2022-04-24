import config from './jest.config'
import {config as envConfig} from 'dotenv'

envConfig()

config.testRegex = "\\.ispec\\.ts$"

export default config;
