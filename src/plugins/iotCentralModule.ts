import { Server, Plugin } from '@hapi/hapi';
import { Mqtt } from 'azure-iot-device-mqtt';
import {
    ModuleClient,
    Twin,
    Message as IoTMessage,
    DeviceMethodRequest,
    DeviceMethodResponse
} from 'azure-iot-device';
import { bind, defer, sleep } from '../utils';

declare module '@hapi/hapi' {
    interface ServerOptionsApp {
        iotCentralModule?: IIotCentralModule;
    }
}

const pluginModuleName = 'IotCentralModulePlugin';
const ModuleName = 'IotCentralModule';

export interface IDirectMethodResult {
    status: number;
    message: string;
    payload: any;
}

type DirectMethodFunction = (commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) => Promise<void>;

export interface IIotCentralModulePluginOptions {
    debugTelemetry(): boolean;
    onHandleModuleProperties(desiredProps: any): Promise<void>;
    onHandleDownstreamMessages?(inputName: string, message: IoTMessage): Promise<void>;
    onModuleConnect?(): void;
    onModuleDisconnect?(): void;
    onModuleClientError?(error: Error): void;
    onModuleReady(): Promise<void>;
}

export interface IIotCentralModule {
    moduleId: string;
    deviceId: string;
    getModuleClient(): ModuleClient;
    debugTelemetry(): boolean;
    sendMeasurement(data: any, outputName?: string): Promise<void>;
    updateModuleProperties(properties: any): Promise<void>;
    addDirectMethod(directMethodName: string, directMethodFunction: DirectMethodFunction): void;
    invokeDirectMethod(moduleId: string, methodName: string, payload: any): Promise<IDirectMethodResult>;
}

export const iotCentralModulePlugin: Plugin<any> = {
    name: 'IotCentralModulePlugin',

    // @ts-ignore (server, options)
    register: async (server: Server, options: IoTCentralModulePluginOptions) => {
        server.log([pluginModuleName, 'info'], 'register');

        if (!options.debugTelemetry) {
            throw new Error('Missing required option debugTelemetry in IoTCentralModuleOptions');
        }

        if (!options.onHandleModuleProperties) {
            throw new Error('Missing required option onHandleModuleProperties in IoTCentralModuleOptions');
        }

        if (!options.onModuleReady) {
            throw new Error('Missing required option onModuleReady in IoTCentralModuleOptions');
        }

        const plugin = new IotCentralModule(server, options);

        server.settings.app.iotCentralModule = plugin;

        await plugin.startModule();
    }
};

class IotCentralModule implements IIotCentralModule {
    private server: Server;
    private moduleClient: ModuleClient = null;
    private moduleTwin: Twin = null;
    private deferredStart = defer();
    private options: IIotCentralModulePluginOptions;

    constructor(server: Server, options: IIotCentralModulePluginOptions) {
        this.server = server;
        this.options = options;
    }

    public async startModule(): Promise<boolean> {
        let result = false;

        try {
            for (let connectCount = 1; !result && connectCount <= 3; connectCount++) {
                result = await this.connectModuleClient();

                if (!result) {
                    this.server.log([ModuleName, 'error'], `Connect client attempt failed (${connectCount} of 3)${connectCount < 3 ? ' - retry in 5 seconds' : ''}`);
                    await sleep(5000);
                }
            }

            if (result) {
                await this.deferredStart.promise;

                await this.options.onModuleReady();
            }
        }
        catch (ex) {
            result = false;

            this.server.log([ModuleName, 'error'], `Exception while starting IotCentralModule plugin: ${ex.message}`);
        }

        return result;
    }

    public moduleId: string = process.env.IOTEDGE_MODULEID || '';
    public deviceId: string = process.env.IOTEDGE_DEVICEID || '';

    public getModuleClient(): ModuleClient {
        return this.moduleClient;
    }

    public debugTelemetry(): boolean {
        return this.options.debugTelemetry();
    }

    public async sendMeasurement(data: any, outputName?: string): Promise<void> {
        if (!data || !this.moduleClient) {
            return;
        }

        try {
            const iotcMessage = new IoTMessage(JSON.stringify(data));

            if (outputName) {
                await this.moduleClient.sendOutputEvent(outputName, iotcMessage);
            }
            else {
                await this.moduleClient.sendEvent(iotcMessage);
            }

            if (this.debugTelemetry()) {
                this.server.log([ModuleName, 'info'], `sendEvent: ${JSON.stringify(data, null, 4)}`);
            }
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `sendMeasurement: ${ex.message}`);
        }
    }

    public async updateModuleProperties(properties: any): Promise<void> {
        if (!properties || !this.moduleTwin) {
            return;
        }

        try {
            await new Promise((resolve, reject) => {
                this.moduleTwin.properties.reported.update(properties, (error) => {
                    if (error) {
                        return reject(error);
                    }

                    return resolve('');
                });
            });

            if (this.debugTelemetry()) {
                this.server.log([ModuleName, 'info'], `Module properties updated: ${JSON.stringify(properties, null, 4)}`);
            }
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Error updating module properties: ${ex.message}`);
        }
    }

    public addDirectMethod(directMethodName: string, directMethodFunction: DirectMethodFunction): void {
        if (!this.moduleClient) {
            return;
        }

        this.moduleClient.onMethod(directMethodName, directMethodFunction);
    }

    public async invokeDirectMethod(moduleId: string, methodName: string, payload: any): Promise<IDirectMethodResult> {
        const directMethodResult = {
            status: 200,
            message: '',
            payload: {}
        };

        if (!this.moduleClient) {
            return directMethodResult;
        }

        try {
            const methodParams = {
                methodName,
                payload,
                connectTimeoutInSeconds: 30,
                responseTimeoutInSeconds: 30
            };

            if (this.debugTelemetry()) {
                this.server.log([ModuleName, 'info'], `invokeOnvifModuleMethod request: ${JSON.stringify(methodParams, null, 4)}`);
            }

            const response = await this.moduleClient.invokeMethod(this.server.settings.app.iotCentralModule.deviceId, moduleId, methodParams);

            if (this.debugTelemetry()) {
                this.server.log([ModuleName, 'info'], `invokeOnvifModuleMethod response: ${JSON.stringify(response, null, 4)}`);
            }

            directMethodResult.status = response.status;

            if (response.status < 200 || response.status > 299) {
                // throw new Error(`(from invokeMethod) ${response.payload.error?.message}`);
                directMethodResult.message = `Error executing directMethod ${methodName} on module ${moduleId}, status: ${response.status}`;
                this.server.log([ModuleName, 'error'], directMethodResult.message);
            }
            else {
                directMethodResult.message = `invokeMethod succeeded`;
                directMethodResult.payload = response.payload;
            }
        }
        catch (ex) {
            directMethodResult.status = 500;
            directMethodResult.message = `Exception while calling invokeMethod: ${ex.message}`;
            this.server.log([ModuleName, 'error'], directMethodResult.message);
        }

        return directMethodResult;
    }

    private async connectModuleClient(): Promise<boolean> {
        let result = true;

        if (this.moduleClient) {
            if (this.moduleTwin) {
                this.moduleTwin.removeAllListeners();
            }

            if (this.moduleClient) {
                this.moduleClient.removeAllListeners();

                await this.moduleClient.close();
            }

            this.moduleClient = null;
            this.moduleTwin = null;
        }

        try {
            this.server.log([ModuleName, 'info'], `IOTEDGE_WORKLOADURI: ${process.env.IOTEDGE_WORKLOADURI}`);
            this.server.log([ModuleName, 'info'], `IOTEDGE_DEVICEID: ${process.env.IOTEDGE_DEVICEID}`);
            this.server.log([ModuleName, 'info'], `IOTEDGE_MODULEID: ${process.env.IOTEDGE_MODULEID}`);
            this.server.log([ModuleName, 'info'], `IOTEDGE_MODULEGENERATIONID: ${process.env.IOTEDGE_MODULEGENERATIONID}`);
            this.server.log([ModuleName, 'info'], `IOTEDGE_IOTHUBHOSTNAME: ${process.env.IOTEDGE_IOTHUBHOSTNAME}`);
            this.server.log([ModuleName, 'info'], `IOTEDGE_AUTHSCHEME: ${process.env.IOTEDGE_AUTHSCHEME}`);

            this.moduleClient = await ModuleClient.fromEnvironment(Mqtt);
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Failed to instantiate client interface from configuraiton: ${ex.message}`);
        }

        if (!this.moduleClient) {
            return false;
        }

        try {
            this.moduleClient.on('connect', this.onModuleConnect);
            this.moduleClient.on('disconnect', this.onModuleDisconnect);
            this.moduleClient.on('error', this.onModuleClientError);

            this.server.log([ModuleName, 'info'], `Waiting for dependent modules to initialize (approx. 15s)...`);
            await sleep(15000);

            await this.moduleClient.open();

            this.server.log([ModuleName, 'info'], `Client is connected`);

            // TODO:
            // Should the module twin interface get connected *BEFORE* opening
            // the moduleClient above?
            this.moduleTwin = await this.moduleClient.getTwin();
            this.moduleTwin.on('properties.desired', this.onHandleModuleProperties);
            this.moduleClient.on('inputMessage', this.onHandleDownstreamMessages);

            this.server.log([ModuleName, 'info'], `IoT Central successfully connected module: ${process.env.IOTEDGE_MODULEID}, instance id: ${process.env.IOTEDGE_DEVICEID}`);
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `IoT Central connection error: ${ex.message}`);

            result = false;
        }

        return result;
    }

    @bind
    private async onHandleModuleProperties(desiredChangedSettings: any): Promise<void> {
        if (!this.moduleClient) {
            return;
        }

        await this.options.onHandleModuleProperties(desiredChangedSettings);

        this.deferredStart.resolve();
    }

    @bind
    private async onHandleDownstreamMessages(inputName: string, message: IoTMessage): Promise<void> {
        if (!this.moduleClient || !message) {
            return;
        }

        if (this.options.onHandleDownstreamMessages) {
            await this.options.onHandleDownstreamMessages(inputName, message);
        }
    }

    @bind
    private onModuleConnect() {
        if (this.options.onModuleConnect) {
            this.options.onModuleConnect();
        }
        else {
            this.server.log([ModuleName, 'info'], `The module received a connect event`);
        }
    }

    @bind
    private onModuleDisconnect() {
        if (this.options.onModuleDisconnect) {
            this.options.onModuleDisconnect();
        }
        else {
            this.server.log([ModuleName, 'info'], `The module received a disconnect event`);
        }
    }

    @bind
    private onModuleClientError(error: Error) {
        try {
            this.moduleClient = null;
            this.moduleTwin = null;

            if (this.options.onModuleClientError) {
                this.options.onModuleClientError(error);
            }
            else {
                this.server.log([ModuleName, 'error'], `Module client connection error: ${error.message}`);
            }
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Module client connection error: ${ex.message}`);
        }
    }
}
