import { ContainerMap, ContainerPlan } from './fleetform/fleetformTypes';
import { DockerExecuter } from './docker/DockerExecuter';
import {
    connect,
    createContainer,
    createNetwork,
    detachContainer,
    printAndPullImage,
    removeContainer,
    removeNetwork,
    startContainer
} from './docker/dockerFunc';
import { Container } from 'dockerode';
import * as crypto from "crypto"

export interface BaseTask {
    type: string,
    name: string,
}

export interface PullImageTask extends BaseTask {
    type: "image.pull",
    name: string,
}

export interface StartContainerTask extends BaseTask {
    type: "container.start",
    name: string,
}

export interface CreateContainerTask extends BaseTask {
    type: "container.create",
    name: string,
    plan: ContainerPlan,
}

export interface DeleteContainerTask extends BaseTask {
    type: "container.delete",
    name: string,
}

export interface DetachContainerTask extends BaseTask {
    type: "container.detach",
    name: string,
}

export interface CreateNetworkTask extends BaseTask {
    type: "network.create",
    name: string,
}

export interface DeleteNetworkTask extends BaseTask {
    type: "network.delete",
    name: string,
}

export interface AttachNetworkTask extends BaseTask {
    type: "network.attach",
    name: string,
    target: string,
}

export type Task = PullImageTask |
    StartContainerTask |
    CreateContainerTask |
    DetachContainerTask |
    DeleteContainerTask |
    CreateNetworkTask |
    DeleteNetworkTask |
    AttachNetworkTask

export type ParallelSet = Task[]
export type TaskSet = ParallelSet[]
export interface HostTaskSet {
    [host: string]: TaskSet
}

export interface HostResourceInfo {
    containerNames: string[],
    networkNames: string[],
    containerHash: {
        [name: string]: string
    },
}

export async function getHostResourceInfo(
    executer: DockerExecuter,
    prefix: string,
    hashKey: string = "ff_hash",
    labelKey: string | undefined = "source",
    labelValue: string | undefined = "fleetform",
): Promise<HostResourceInfo> {
    const stat: HostResourceInfo = {
        containerNames: [],
        networkNames: [],
        containerHash: {},
    }
    const [container, networks] = await Promise.all([
        executer.listContainers({
            all: true,
        }),
        executer.listNetworks()
    ])
    container.forEach((containerInfo) => {
        let name = containerInfo.Names[0]
        if (name.startsWith("/")) {
            name = name.substring(1)
        }
        if (typeof name == "string" && name.startsWith(prefix)) {
            if (
                !labelKey ||
                !labelValue ||
                containerInfo.Labels[labelKey] === labelValue
            ) {
                name = name.substring(prefix.length)
                stat.containerNames.push(name)
                stat.containerHash[name] = containerInfo.Labels[hashKey] ?? ""
            }
        }
    })
    networks.forEach((networkInfo) => {
        let name = networkInfo.Name
        if (name.startsWith("/")) {
            name = name.substring(1)
        }
        if (typeof name == "string" && name.startsWith(prefix)) {
            if (
                !labelKey ||
                !labelValue ||
                networkInfo.Labels[labelKey] === labelValue
            ) {
                stat.networkNames.push(name.substring(prefix.length))
            }
        }
    })
    return stat
}

export function filterDoubleValues(
    array: string[],
    double?: (value: string) => void
): string[] {
    return array.filter((value, index, self) => {
        if (self.indexOf(value) === index) {
            return true
        }
        if (double) {
            double(value)
        }
        return false
    })
}

export function hashContianerPlan(containerPlan: ContainerPlan): string {
    return crypto
        .createHash('sha1')
        .update(
            JSON.stringify(containerPlan)
        )
        .digest('base64')
        .substring(4, 20)
}

export function generateHostTaskSet(
    res: HostResourceInfo,
    containerMap: ContainerMap,
    renewContainerNames: string[],
    renewNetworkNames: string[],
    prefix: string,
): TaskSet {
    const containerHashs: {
        [name: string]: string
    } = {}

    res.containerNames = filterDoubleValues(
        res.containerNames,
        (value) => renewContainerNames.push(value)
    )
    res.networkNames = filterDoubleValues(
        res.networkNames,
        (value) => renewNetworkNames.push(value)
    )

    const tasks: TaskSet = []
    let containerNames = Object.keys(containerMap)
        .filter((name) => containerMap[name].enabled === true)

    let networkNames: string[] = []
    containerNames.forEach((containerName) => {
        const containerData = containerMap[containerName]
        containerData.networks.forEach((network) => {
            if (!networkNames.includes(network)) {
                networkNames.push(network)
            }
        })
    })

    containerNames = filterDoubleValues(containerNames)
    networkNames = filterDoubleValues(networkNames)

    containerNames.forEach((containerName) => {
        containerHashs[containerName] = hashContianerPlan(
            containerMap[containerName]
        )
        if (containerHashs[containerName] != res.containerHash[containerName]) {
            renewContainerNames.push(containerName)
        }
    })

    renewContainerNames = filterDoubleValues(renewContainerNames)
    renewNetworkNames = filterDoubleValues(renewNetworkNames)

    // add existing but not planned containers to delete container names
    const deleteContainerNames = res.containerNames
        .filter((name) => !containerNames.includes(name))
    // add renew container to delete container names
    renewContainerNames.forEach((renewContainerName) => {
        if (!deleteContainerNames.includes(renewContainerName)) {
            deleteContainerNames.push(renewContainerName)
        }
    })
    // add existing but not planned networks to delete network names
    const deleteNetworkNames = res.networkNames
        .filter((name) => !networkNames.includes(name))
    // add renew network to delete network names
    renewNetworkNames.forEach((renewNetworkName) => {
        if (!deleteNetworkNames.includes(renewNetworkName)) {
            deleteNetworkNames.push(renewNetworkName)
        }
    })

    // add not existing but planned containers to create container names
    const createContainerNames = containerNames
        .filter((name) => !res.containerNames.includes(name))
    // add renew container to delete container names
    renewContainerNames.forEach((renewContainerName) => {
        if (!createContainerNames.includes(renewContainerName)) {
            createContainerNames.push(renewContainerName)
        }
    })

    // add not existing but planned networks to create network names
    const createNetworkNames = networkNames
        .filter((name) => !res.networkNames.includes(name))
    // add renew network to delete network names
    renewNetworkNames.forEach((renewNetworkName) => {
        if (!createNetworkNames.includes(renewNetworkName)) {
            createNetworkNames.push(renewNetworkName)
        }
    })

    const images = filterDoubleValues(
        createContainerNames.map(
            (containerName) =>
                containerMap[containerName].image + ":" +
                (containerMap[containerName].tag ?? "latest")
        )
    )

    // add all needed images pull tasts
    images.forEach(
        (image) => {
            tasks.push([
                {
                    type: "image.pull",
                    name: image,
                }
            ])
        }
    )

    // add delete container tasks
    tasks.push(deleteContainerNames.map(
        (containerName): DeleteContainerTask => {
            return {
                type: "container.delete",
                name: prefix + containerName,
            }
        }
    ))
    // add delete network tasks
    tasks.push(deleteNetworkNames.map(
        (networkName): DeleteNetworkTask => {
            return {
                type: "network.delete",
                name: prefix + networkName,
            }
        }
    ))
    tasks.push([
        // add create network tasks
        ...createNetworkNames.map(
            (networkName): CreateNetworkTask => {
                return {
                    type: "network.create",
                    name: prefix + networkName,
                }
            }
        ),
        // add create container tasks
        ...createContainerNames.map(
            (containerName): CreateContainerTask => {
                return {
                    type: "container.create",
                    name: prefix + containerName,
                    plan: containerMap[containerName]
                }
            }
        )
    ])
    // add detach container tasks
    tasks.push(containerNames.map(
        (containerName): DetachContainerTask => {
            return {
                type: "container.detach",
                name: prefix + containerName,
            }
        }
    ))

    // add attach network tasks for each container
    containerNames.map((containerName) => {
        // add attach network tasks
        tasks.push(containerMap[containerName].networks.map(
            (networkName): AttachNetworkTask => {
                return {
                    type: "network.attach",
                    name: prefix + networkName,
                    target: prefix + containerName,

                }
            }
        ))
    })
    // add start container tasks
    tasks.push(createContainerNames.map(
        (containerName): StartContainerTask => {
            return {
                type: "container.start",
                name: prefix + containerName,
            }
        }
    ))

    return tasks.filter((v) => v.length > 0)
}

export async function containerCreate(
    executer: DockerExecuter,
    name: string,
    containerPlan: ContainerPlan,
): Promise<void> {
    await createContainer(
        executer,
        {
            ...containerPlan,
            name: name,
            labels: {
                name: name,
                source: "fleetform",
                "ff_hash": hashContianerPlan(containerPlan)
            },
        }
    )
}

export async function containerStart(
    executer: DockerExecuter,
    name: string,
): Promise<void> {
    await startContainer(
        executer,
        name,
        {
            source: "fleetform"
        }
    )
}

export async function containerDetach(
    executer: DockerExecuter,
    name: string,
): Promise<void> {
    await detachContainer(
        executer,
        name,
        {
            source: "fleetform"
        }
    )
}

export async function containerDelete(
    executer: DockerExecuter,
    name: string,
): Promise<void> {
    await removeContainer(
        executer,
        name,
        {
            source: "fleetform"
        }
    )
}

export async function networkCreate(
    executer: DockerExecuter,
    name: string,
): Promise<void> {
    await createNetwork(
        executer,
        name,
        {
            name: name,
            source: "fleetform"
        }
    )
}

export async function networkDelete(
    executer: DockerExecuter,
    name: string,
): Promise<void> {
    await removeNetwork(
        executer,
        name,
        {
            source: "fleetform"
        }
    )
}

export async function networkAttach(
    executer: DockerExecuter,
    name: string,
    target: string,
): Promise<void> {
    await connect(
        executer,
        target,
        name,
        {
            source: "fleetform"
        }
    )
}

export async function handleTask(
    executer: DockerExecuter,
    task: Task,
): Promise<void> {
    if (task.type == "image.pull") {
        await printAndPullImage(
            executer,
            task.name
        )
    } else if (task.type == "container.create") {
        await containerCreate(executer, task.name, task.plan)
    } else if (task.type == "container.start") {
        await containerStart(executer, task.name)
    } else if (task.type == "container.detach") {
        await containerDetach(executer, task.name)
    } else if (task.type == "container.delete") {
        await containerDelete(executer, task.name)
    } else if (task.type == "network.create") {
        await networkCreate(executer, task.name)
    } else if (task.type == "network.delete") {
        await networkDelete(executer, task.name)
    } else if (task.type == "network.attach") {
        await networkAttach(executer, task.name, task.target)
    } else {
        throw new Error("Unknown task type " + (task as any).type)
    }
}
