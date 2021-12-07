import * as YAML from 'js-yaml';
import {File, isFile} from './util/file-util';
import {Logger} from './util/logger';
import {Container} from 'typescript-ioc';

export interface IKustomization {
  resources: string[];
}

export class Kustomization implements IKustomization {
  config: IKustomization;
  resources: string[];

  constructor(config?: IKustomization) {
    Object.assign(
      this as any,
      config && config.resources ? config : {resources: []},
      config ? {config} : {config: {apiVersion: 'kustomize.config.k8s.io/v1beta1', kind: 'Kustomization'}}
    );
  }

  addResource(resource: string): Kustomization {
    if (!this.containsResource(resource)) {
      this.resources.push(resource);
      this.resources.sort()
    }

    return this;
  }

  containsResource(resource: string): boolean {
    return this.resources.includes(resource);
  }

  asJson() {
    const resource = Object.assign(
      {},
      this.config,
      {
        resources: this.resources
      }
    );

    return resource;
  }

  asJsonString(): string {
    return JSON.stringify(this.asJson());
  }

  asYamlString(): string {
    return YAML.dump(this.asJson());
  }
}

export const addKustomizeResource = async (kustomizeFile: string | File, path: string): Promise<boolean> => {

  const logger: Logger = Container.get(Logger);

  const file: File = isFile(kustomizeFile) ? kustomizeFile : new File(kustomizeFile);

  const kustomize: Kustomization = await loadKustomize(kustomizeFile);

  logger.debug('Loaded kustomize.yaml: ', kustomize);

  if (kustomize.containsResource(path)) {
    logger.debug('kustomize.yaml already contains resource: ' + path)
    return false;
  }

  logger.debug('Adding resource to kustomize.yaml: ' + path);
  kustomize.addResource(path);

  logger.debug('kustomize.yaml after update:', kustomize);

  logger.debug('Writing updated kustomize.yaml');
  return await file.write(kustomize.asYamlString()).then(() => true);
};

export const loadKustomize = async (kustomizeFile: File | string): Promise<Kustomization> => {

  const file: File = isFile(kustomizeFile) ? kustomizeFile : new File(kustomizeFile);

  if (!await file.exists()) {
    const logger: Logger = Container.get(Logger);
    logger.log(`kustomize.yaml file does not exist. Creating new instance: ` + kustomizeFile.toString());
    return new Kustomization();
  }

  const kustomize: IKustomization = await file.readYaml();

  return new Kustomization(kustomize);
}
