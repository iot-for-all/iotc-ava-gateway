import { HapiPlugin, inject } from 'spryly';
import { Server } from '@hapi/hapi';
import { iotCentralModulePlugin } from './iotCentralModule';
import {
    IModuleEnvironmentConfig,
    CameraGatewayService
} from '../services/cameraGateway';
import * as _get from 'lodash.get';

declare module '@hapi/hapi' {
    interface ServerOptionsApp {
        cameraGatewayPluginModule?: ICameraGatewayPluginModule;
    }
}

const ModuleName = 'CameraGatewayPlugin';

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
            await server.register([
                {
                    plugin: iotCentralModulePlugin,
                    options: {
                        initializeModule: this.cameraGateway.initializeModule.bind(this.cameraGateway),
                        debugTelemetry: this.cameraGateway.debugTelemetry.bind(this.cameraGateway),
                        onHandleModuleProperties: this.cameraGateway.onHandleModuleProperties.bind(this.cameraGateway),
                        onModuleClientError: this.cameraGateway.onModuleClientError.bind(this.cameraGateway),
                        onHandleDownstreamMessages: this.cameraGateway.onHandleDownstreamMessages.bind(this.cameraGateway),
                        onModuleReady: this.cameraGateway.onModuleReady.bind(this.cameraGateway)
                    }
                }
            ]);

            const plugin = new CameraGatewayPluginModule();

            server.settings.app.cameraGatewayPluginModule = plugin;
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
