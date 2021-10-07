import { HapiPlugin, inject } from 'spryly';
import { Server } from '@hapi/hapi';
import {
    IIotCentralPluginModuleOptions,
    iotCentralPluginModule
} from './iotCentralModule';
import { blobStoragePluginModule } from './blobStorage';
import {
    IModuleEnvironmentConfig,
    CameraGatewayService
} from '../services/cameraGateway';
import { join as pathJoin } from 'path';
import * as fse from 'fs-extra';

declare module '@hapi/hapi' {
    interface ServerOptionsApp {
        cameraGateway?: ICameraGatewayPluginModule;
    }
}

const ModuleName = 'CameraGatewayPluginModule';

export const DeviceCache = 'deviceCache';
export const PipelineCache = 'pipelines';

export enum DeviceCacheOperation {
    Update,
    Delete
}

export interface ICachedDeviceProvisionInfo {
    dpsConnectionString?: string;
    avaPipelineTopologyName?: string;
    avaLivePipelineName?: string;
    mediaProfileToken?: string;
}

export interface IDeviceCacheInfo {
    cameraInfo: any;
    cachedDeviceProvisionInfo: ICachedDeviceProvisionInfo;
}

export interface ICameraGatewayPluginModule {
    moduleEnvironmentConfig: IModuleEnvironmentConfig;
    getCachedDeviceList(): Promise<IDeviceCacheInfo[]>;
    updateCachedDeviceInfo(operation: DeviceCacheOperation, cameraId: string, cacheProvisionInfo?: IDeviceCacheInfo): Promise<void>;
    initializePipelineCache(): Promise<void>;
}

export class CameraGatewayPlugin implements HapiPlugin {
    @inject('$server')
    private server: Server;

    @inject('cameraGateway')
    private cameraGateway: CameraGatewayService;

    public async init(): Promise<void> {
        this.server.log([ModuleName, 'info'], `init`);
    }

    // @ts-ignore (options)
    public async register(server: Server, options: any): Promise<void> {
        server.log([ModuleName, 'info'], 'register');

        try {
            server.settings.app.cameraGateway = new CameraGatewayPluginModule(server);

            const pluginOptions: IIotCentralPluginModuleOptions = {
                initializeModule: this.cameraGateway.initializeModule.bind(this.cameraGateway),
                debugTelemetry: this.cameraGateway.debugTelemetry.bind(this.cameraGateway),
                onHandleModuleProperties: this.cameraGateway.onHandleModuleProperties.bind(this.cameraGateway),
                onModuleClientError: this.cameraGateway.onModuleClientError.bind(this.cameraGateway),
                onHandleDownstreamMessages: this.cameraGateway.onHandleDownstreamMessages.bind(this.cameraGateway),
                onModuleReady: this.cameraGateway.onModuleReady.bind(this.cameraGateway)
            };

            await server.register([
                {
                    plugin: iotCentralPluginModule,
                    options: pluginOptions
                },
                {
                    plugin: blobStoragePluginModule
                }
            ]);
        }
        catch (ex) {
            server.log([ModuleName, 'error'], `Error while registering : ${ex.message}`);
        }
    }
}

class CameraGatewayPluginModule implements ICameraGatewayPluginModule {
    private server: Server;

    constructor(server: Server) {
        this.server = server;
    }

    public moduleEnvironmentConfig: IModuleEnvironmentConfig = {
        onvifModuleId: process.env.onvifModuleId || 'OnvifModule',
        avaEdgeModuleId: process.env.avaEdgeModuleId || 'avaEdge'
    };

    public async getCachedDeviceList(): Promise<IDeviceCacheInfo[]> {
        const deviceCache = await this.server.settings.app.config.get(DeviceCache);

        return deviceCache?.cache || [];
    }

    public async updateCachedDeviceInfo(operation: DeviceCacheOperation, cameraId: string, cacheProvisionInfo?: IDeviceCacheInfo): Promise<void> {
        try {
            const deviceCache = await this.server.settings.app.config.get(DeviceCache);
            const cachedDeviceList: IDeviceCacheInfo[] = deviceCache?.cache || [];
            const cachedDeviceIndex = cachedDeviceList.findIndex((element) => element.cameraInfo.cameraId === cameraId);

            switch (operation) {
                case DeviceCacheOperation.Update:
                    if (cachedDeviceIndex === -1) {
                        cachedDeviceList.push({
                            cameraInfo: {
                                isOnvifCamera: false,
                                ...cacheProvisionInfo.cameraInfo
                            },
                            cachedDeviceProvisionInfo: {
                                ...cacheProvisionInfo.cachedDeviceProvisionInfo
                            }
                        });
                    }
                    else {
                        cachedDeviceList[cachedDeviceIndex] = {
                            cameraInfo: {
                                ...cachedDeviceList[cachedDeviceIndex].cameraInfo,
                                ...cacheProvisionInfo.cameraInfo
                            },
                            cachedDeviceProvisionInfo: {
                                ...cachedDeviceList[cachedDeviceIndex].cachedDeviceProvisionInfo,
                                ...cacheProvisionInfo.cachedDeviceProvisionInfo
                            }
                        };
                    }
                    break;

                case DeviceCacheOperation.Delete:
                    if (cachedDeviceIndex > -1) {
                        cachedDeviceList.splice(cachedDeviceIndex, 1);
                    }
                    break;
            }

            await this.server.settings.app.config.set(DeviceCache, {
                cache: cachedDeviceList
            });
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Error while updating cached device info (udpate): ${ex.message}`);
        }
    }

    public async initializePipelineCache(): Promise<void> {
        this.server.log([ModuleName, 'info'], `initializePipelineCache`);

        try {
            const files = fse.readdirSync(pathJoin(this.server.settings.app.contentRootDirectory, `mediaPipelines`));
            for (const file of files) {
                // await this.server.settings.app.config.set(pathJoin(PipelineCache, contentName), avaPipelineContent);
                fse.copySync(pathJoin(this.server.settings.app.contentRootDirectory, `mediaPipelines`, file), pathJoin(this.server.settings.app.storageRootDirectory, PipelineCache, file));
            }
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Exception while initializing the pipeline cache: ${ex.message}`);
        }
    }
}
