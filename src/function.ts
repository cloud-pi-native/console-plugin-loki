import { Environment, parseError, UserObject, type Project, type StepCall } from '@cpn-console/hooks'
import { removeTrailingSlash, requiredEnv } from '@cpn-console/shared'

import { Gitlab } from '@gitbeaker/rest'
import { Gitlab as IGitlab } from '@gitbeaker/core'

import { deleteGitlabYamlConfig, upsertGitlabConfig } from './yaml.js'
import type { BaseParams, Stage } from './utils.js'
import { deleteKeycloakGroup, ensureKeycloakGroups } from './keycloak.js'
import { KeycloakProjectApi } from '@cpn-console/keycloak-plugin/types/class.js'
import { deleteAllDataSources, deleteGrafanaInstance, ensureDataSource, ensureGrafanaInstance } from './kubernetes.js'

const getBaseParams = (project: Project, stage: Stage): BaseParams => ({ organizationName: project.organization.name, projectName: project.name, stage })

export type ListPerms = Record<'prod' | 'hors-prod', Record<'view' | 'edit', UserObject['id'][]>>

const getListPrems = (environments: Environment[]): ListPerms => {
  const allProdPerms = environments
    .filter(env => env.stage === 'prod')
    .map(env => env.permissions)
    .flat()
  const allHProdPerms = environments
    .filter(env => env.stage !== 'prod')
    .map(env => env.permissions)
    .flat()

  const listPerms: ListPerms = {
    'hors-prod': {
      edit: [],
      view: [],
    },
    prod: {
      edit: [],
      view: [],
    },
  }
  for (const permission of allProdPerms) {
    if (permission.permissions.rw && !listPerms.prod.edit.includes(permission.userId)) {
      listPerms.prod.edit.push(permission.userId)
    }
    if (permission.permissions.ro && !listPerms.prod.view.includes(permission.userId)) {
      listPerms.prod.view.push(permission.userId)
    }
  }
  for (const permission of allHProdPerms) {
    if (permission.permissions.rw && !listPerms['hors-prod'].edit.includes(permission.userId)) {
      listPerms['hors-prod'].edit.push(permission.userId)
    }
    if (permission.permissions.ro && !listPerms['hors-prod'].view.includes(permission.userId)) {
      listPerms['hors-prod'].view.push(permission.userId)
    }
  }
  return listPerms
}

const getApi = (): IGitlab => {
  const gitlabUrl = removeTrailingSlash(requiredEnv('GITLAB_URL'))
  const gitlabToken = requiredEnv('GITLAB_TOKEN')
  // @ts-ignore
  return new Gitlab({ token: gitlabToken, host: gitlabUrl });
}

export const upsertProject: StepCall<Project> = async (payload) => {
  try {
    // init args
    const project = payload.args
    const keycloakApi = payload.apis.keycloak
    // init gitlab api
    const api = getApi()
    const keycloakRootGroupPath = await keycloakApi.getProjectGroupPath()

    const hasProd = project.environments.find(env => env.stage === 'prod')
    const hasNonProd = project.environments.find(env => env.stage !== 'prod')
    const hProdParams = getBaseParams(project, 'hprod')
    const prodParams = getBaseParams(project, 'prod')
    const listPerms = getListPrems(project.environments)

    await Promise.all([
      ensureKeycloakGroups(listPerms, keycloakApi),
      // Upsert or delete Gitlab config based on prod/non-prod environment
      ...(hasProd
        ? [await upsertGitlabConfig(prodParams, keycloakRootGroupPath, project, api)]
        : [await deleteGitlabYamlConfig(prodParams, project, api)]),
      ...(hasNonProd
        ? [await upsertGitlabConfig(hProdParams, keycloakRootGroupPath, project, api)]
        : [await deleteGitlabYamlConfig(hProdParams, project, api)]),
    ])

    return {
      status: {
        result: 'OK',
        message: 'Created',
      },
    }
  } catch (error) {
    return {
      status: {
        result: 'KO',
        message: 'An error happened while creating Kibana resources',
      },
      error: parseError(error),
    }
  }
}

export const deleteProject: StepCall<Project> = async (payload) => {
  try {
    const project = payload.args
    const api = getApi() // API GitLab
    const keycloakApi = payload.apis.keycloak
    const hProdParams = getBaseParams(project, 'hprod')
    const prodParams = getBaseParams(project, 'prod')

    await Promise.all([
      deleteKeycloakGroup(keycloakApi),
      // deleteGrafanaConfig(prodParams),
      // deleteGrafanaConfig(hProdParams),
      deleteGitlabYamlConfig(prodParams, project, api),
      deleteGitlabYamlConfig(hProdParams, project, api),
    ])

    return {
      status: {
        result: 'OK',
        message: 'Deleted',
      },
    }
  } catch (error) {
    return {
      status: {
        result: 'OK',
        message: 'An error happened while deleting resources',
      },
      error: JSON.stringify(error),
    }
  }
}

export const upsertGrafanaConfig = (params: BaseParams, keycloakApi: KeycloakProjectApi) => [
  ensureDataSource(params, 'alert-manager'),
  ensureDataSource(params, 'prometheus'),
  ensureDataSource(params, 'loki'),
  ensureGrafanaInstance(params, keycloakApi),
]

export const deleteGrafanaConfig = (params: BaseParams) => [
  deleteGrafanaInstance(params),
  deleteAllDataSources(params),
]
