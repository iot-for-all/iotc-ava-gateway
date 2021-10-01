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
import * as _get from 'lodash.get';

declare module '@hapi/hapi' {
    interface ServerOptionsApp {
        cameraGateway?: ICameraGatewayPluginModule;
    }
}

const ModuleName = 'CameraGatewayPluginModule';

export interface ICameraGatewayPluginModule {
    moduleEnvironmentConfig: IModuleEnvironmentConfig;
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
            server.settings.app.cameraGateway = new CameraGatewayPluginModule();

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
    public moduleEnvironmentConfig: IModuleEnvironmentConfig = {
        onvifModuleId: process.env.onvifModuleId || 'OnvifModule',
        avaEdgeModuleId: process.env.avaEdgeModuleId || 'avaEdge'
    };
}
