import { HapiPlugin, inject } from 'spryly';
import { Server } from '@hapi/hapi';
import { iotCentralModulePlugin } from './iotCentralModule';
import { CameraGatewayService } from '../services/cameraGateway';
import * as _get from 'lodash.get';

const ModuleName = 'CameraGatewayPlugin';

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
                        debugTelemetry: this.cameraGateway.debugTelemetry.bind(this.cameraGateway),
                        onHandleModuleProperties: this.cameraGateway.onHandleModuleProperties.bind(this.cameraGateway),
                        onModuleClientError: this.cameraGateway.onModuleClientError.bind(this.cameraGateway),
                        onHandleDownstreamMessages: this.cameraGateway.onHandleDownstreamMessages.bind(this.cameraGateway),
                        onModuleReady: this.cameraGateway.onModuleReady.bind(this.cameraGateway)
                    }
                }
            ]);
        }
        catch (ex) {
            server.log([ModuleName, 'error'], `Error while registering : ${ex.message}`);
        }
    }
}
