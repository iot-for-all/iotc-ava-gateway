import { service, inject } from 'spryly';
import { Server } from '@hapi/hapi';
import { IIotCentralPluginModule } from 'src/plugins/iotCentralModule';
import { IBlobStoragePluginModuleOptions } from 'src/plugins/blobStorage';
import { HealthState } from './health';
import { AvaPipeline } from './avaPipeline';
import {
    AvaCameraDevice,
    IPlainCameraInformation
} from './device';
import { SymmetricKeySecurityClient } from 'azure-iot-security-symmetric-key';
import {
    RegistrationResult,
    ProvisioningDeviceClient
} from 'azure-iot-provisioning-device';
import { Mqtt as ProvisioningTransport } from 'azure-iot-provisioning-device-mqtt';
import {
    Message as IoTMessage,
    DeviceMethodRequest,
    DeviceMethodResponse
} from 'azure-iot-device';
import {
    arch as osArch,
    hostname as osHostname,
    platform as osPlatform,
    type as osType,
    release as osRelease,
    version as osVersion,
    cpus as osCpus,
    totalmem as osTotalMem,
    freemem as osFreeMem,
    loadavg as osLoadAvg
} from 'os';
import * as crypto from 'crypto';
import * as Wreck from '@hapi/wreck';
import { URL } from 'url';
import { bind, emptyObj, forget, sleep } from '../utils';

const ModuleName = 'CameraGatewayService';
const IotcOutputName = 'iotc';
const defaultHealthCheckRetries = 3;
const defaultDpsProvisioningHost = 'global.azure-devices-provisioning.net';
const defaultAvaOnvifCameraModelId = 'dtmi:com:azuremedia:model:AvaOnvifCameraDevice;1';

const GatewayConfig = 'gatewayConfig';
const DeviceCache = 'deviceCache';
export const PipelineCache = 'pipelines';

type DeviceOperation = 'DELETE_CAMERA' | 'SEND_EVENT' | 'SEND_INFERENCES';

export interface IModuleEnvironmentConfig {
    onvifModuleId: string;
    avaEdgeModuleId: string;
}

interface IModuleConfig {
    appSubDomain: string;
    appBaseDomain: string;
    apiToken: string;
    deviceKey: string;
    scopeId: string;
    dpsProvisioningHost?: string;
    avaOnvifCameraModelId?: string;
}

export interface ICameraProvisionInfo {
    cameraId: string;
    cameraName: string;
    ipAddress: string;
    username: string;
    password: string;
    isOnvifCamera?: boolean;
    plainCameraInformation?: IPlainCameraInformation;
}

interface ICameraOperationInfo {
    cameraId: string;
    operationInfo: any;
}

enum DeviceCacheOperation {
    Update,
    Delete
}
interface IDeviceCacheInfo {
    cameraInfo: ICameraProvisionInfo;
    dpsConnectionString: string;
}

interface IProvisionResult {
    dpsProvisionStatus: boolean;
    dpsProvisionMessage: string;
    dpsHubConnectionString: string;
    clientConnectionStatus: boolean;
    clientConnectionMessage: string;
    avaInferenceDevice: AvaCameraDevice;
}

interface IDeviceOperationResult {
    status: boolean;
    message: string;
}

interface ISystemProperties {
    cpuModel: string;
    cpuCores: number;
    cpuUsage: number;
    totalMemory: number;
    freeMemory: number;
}

enum IotcEdgeHostDevicePropNames {
    Hostname = 'hostname',
    ProcessorArchitecture = 'processorArchitecture',
    Platform = 'platform',
    OsType = 'osType',
    OsName = 'osName',
    TotalMemory = 'totalMemory',
    SwVersion = 'swVersion'
}

enum IoTCentralClientState {
    Disconnected = 'disconnected',
    Connected = 'connected'
}

enum ModuleState {
    Inactive = 'inactive',
    Active = 'active'
}

interface IConfigureGatewayCommandRequestParmas {
    moduleConfig: IModuleConfig;
    blobStorage: IBlobStoragePluginModuleOptions;
}

interface IDiscoverCamerasCommandRequestParams {
    timeout: number;
}

interface IRestartGatewayModuleCommandRequestParams {
    timeout: number;
}

interface IDeleteCameraCommandRequestParams {
    cameraId: string;
}

interface ModuleCommandResponse {
    statusCode: number;
    message: string;
    payload?: any;
}

enum AvaGatewayCapability {
    tlSystemHeartbeat = 'tlSystemHeartbeat',
    tlFreeMemory = 'tlFreeMemory',
    tlConnectedCameras = 'tlConnectedCameras',
    stIoTCentralClientState = 'stIoTCentralClientState',
    stModuleState = 'stModuleState',
    evConfigureGateway = 'evConfigureGateway',
    evCreateCamera = 'evCreateCamera',
    evDeleteCamera = 'evDeleteCamera',
    evModuleStarted = 'evModuleStarted',
    evModuleStopped = 'evModuleStopped',
    evModuleRestart = 'evModuleRestart',
    evCameraDiscoveryInitiated = 'evCameraDiscoveryInitiated',
    evCameraDiscoveryCompleted = 'evCameraDiscoveryCompleted',
    wpDebugTelemetry = 'wpDebugTelemetry',
    wpDebugRoutedMessage = 'wpDebugRoutedMessage',
    cmConfigureGateway = 'cmConfigureGateway',
    cmDiscoverOnvifCameras = 'cmDiscoverOnvifCameras',
    cmAddOnvifCameraDevice = 'cmAddOnvifCamera',
    cmAddCameraDevice = 'cmAddCamera',
    cmDeleteCameraDevice = 'cmDeleteCamera',
    cmGetCameraDevices = 'cmGetCameras',
    cmRestartGatewayModule = 'cmRestartGatewayModule',
    cmClearDeviceCache = 'cmClearDeviceCache',
    cmClearPipelineCache = 'cmClearPipelineCache'
}

interface IAvaGatewaySettings {
    [AvaGatewayCapability.wpDebugTelemetry]: boolean;
    [AvaGatewayCapability.wpDebugRoutedMessage]: boolean;
}

const AvaGatewayEdgeInputs = {
    CameraCommand: 'cameracommand',
    AvaDiagnostics: 'avaDiagnostics',
    AvaOperational: 'avaOperational',
    AvaTelemetry: 'avaTelemetry'
};

const AvaGatewayCommands = {
    CreateOnvifCamera: 'createonvifcamera',
    CreateCamera: 'createcamera',
    DeleteCamera: 'deletecamera',
    SendDeviceTelemetry: 'senddevicetelemetry',
    SendDeviceInferences: 'senddeviceinferences'
};

@service('cameraGateway')
export class CameraGatewayService {
    @inject('$server')
    private server: Server;

    private iotCentralPluginModule: IIotCentralPluginModule;
    private healthCheckRetries: number = defaultHealthCheckRetries;
    private healthState = HealthState.Good;
    private healthCheckFailStreak = 0;
    private moduleSettings: IAvaGatewaySettings = {
        [AvaGatewayCapability.wpDebugTelemetry]: false,
        [AvaGatewayCapability.wpDebugRoutedMessage]: false
    };
    private avaInferenceDeviceMap = new Map<string, AvaCameraDevice>();
    private moduleConfig: IModuleConfig = {
        appSubDomain: '',
        appBaseDomain: '',
        apiToken: '',
        deviceKey: '',
        scopeId: ''
    };

    public async init(): Promise<void> {
        this.server.log([ModuleName, 'info'], 'initialize');
    }

    @bind
    public initializeModule(): void {
        this.iotCentralPluginModule = this.server.settings.app.iotCentral;
    }

    @bind
    public debugTelemetry(): boolean {
        return this.moduleSettings[AvaGatewayCapability.wpDebugTelemetry];
    }

    @bind
    public async onHandleModuleProperties(desiredChangedSettings: any): Promise<void> {
        try {
            this.server.log([ModuleName, 'info'], `onHandleModuleProperties`);
            if (this.debugTelemetry()) {
                this.server.log([ModuleName, 'info'], `desiredChangedSettings:\n${JSON.stringify(desiredChangedSettings, null, 4)}`);
            }

            const patchedProperties = {};

            for (const setting in desiredChangedSettings) {
                if (!Object.prototype.hasOwnProperty.call(desiredChangedSettings, setting)) {
                    continue;
                }

                if (setting === '$version') {
                    continue;
                }

                const value = desiredChangedSettings[setting];

                switch (setting) {
                    case AvaGatewayCapability.wpDebugTelemetry:
                    case AvaGatewayCapability.wpDebugRoutedMessage:
                        patchedProperties[setting] = {
                            value: this.moduleSettings[setting] = value || false,
                            ac: 200,
                            ad: 'completed',
                            av: desiredChangedSettings['$version']
                        };
                        break;

                    default:
                        this.server.log([ModuleName, 'error'], `Received desired property change for unknown setting '${setting}'`);
                        break;
                }
            }

            if (!emptyObj(patchedProperties)) {
                await this.iotCentralPluginModule.updateModuleProperties(patchedProperties);
            }
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Exception while handling desired properties: ${ex.message}`);
        }
    }

    @bind
    public onModuleClientError(error: Error): void {
        this.server.log([ModuleName, 'error'], `Module client connection error: ${error.message}`);
        this.healthState = HealthState.Critical;
    }

    @bind
    public async onHandleDownstreamMessages(inputName: string, message: IoTMessage): Promise<void> {
        try {
            if (inputName === AvaGatewayEdgeInputs.AvaDiagnostics && !this.debugTelemetry()) {
                return;
            }

            const messageData = message.getBytes().toString('utf8');
            if (!messageData) {
                return;
            }

            const messageJson = JSON.parse(messageData);

            if (this.moduleSettings[AvaGatewayCapability.wpDebugRoutedMessage] === true) {
                if (message.properties?.propertyList) {
                    this.server.log([ModuleName, 'info'], `Routed message properties: ${JSON.stringify(message.properties?.propertyList, null, 4)}`);
                }

                this.server.log([ModuleName, 'info'], `Routed message data: ${JSON.stringify(messageJson, null, 4)}`);
            }

            switch (inputName) {
                case AvaGatewayEdgeInputs.CameraCommand: {
                    const edgeInputCameraCommand = messageJson?.command;
                    const edgeInputCameraCommandData = messageJson?.data;

                    switch (edgeInputCameraCommand) {
                        case AvaGatewayCommands.CreateCamera: {
                            await this.createAvaInferenceDevice(edgeInputCameraCommandData);
                            break;
                        }

                        case AvaGatewayCommands.DeleteCamera:
                            await this.avaInferenceDeviceOperation('DELETE_CAMERA', edgeInputCameraCommandData);
                            break;

                        case AvaGatewayCommands.SendDeviceTelemetry:
                            await this.avaInferenceDeviceOperation('SEND_EVENT', edgeInputCameraCommandData);
                            break;

                        case AvaGatewayCommands.SendDeviceInferences:
                            await this.avaInferenceDeviceOperation('SEND_INFERENCES', edgeInputCameraCommandData);
                            break;

                        default:
                            this.server.log([ModuleName, 'warning'], `Warning: received routed message for unknown input: ${inputName}`);
                            break;
                    }

                    break;
                }

                case AvaGatewayEdgeInputs.AvaDiagnostics:
                case AvaGatewayEdgeInputs.AvaOperational:
                case AvaGatewayEdgeInputs.AvaTelemetry: {
                    const cameraId = AvaPipeline.getCameraIdFromAvaMessage(message);
                    if (!cameraId) {
                        if (this.debugTelemetry()) {
                            this.server.log([ModuleName, 'error'], `Received ${inputName} message but no cameraId was found in the subject property`);
                            this.server.log([ModuleName, 'error'], `${inputName} eventType: ${AvaPipeline.getAvaMessageProperty(message, 'eventType')}`);
                            this.server.log([ModuleName, 'error'], `${inputName} subject: ${AvaPipeline.getAvaMessageProperty(message, 'subject')}`);
                        }

                        break;
                    }

                    const avaInferenceDevice = this.avaInferenceDeviceMap.get(cameraId);
                    if (!avaInferenceDevice) {
                        this.server.log([ModuleName, 'error'], `Received Ava Edge telemetry for cameraId: "${cameraId}" but that device does not exist in Ava Gateway`);
                    }
                    else {
                        if (inputName === AvaGatewayEdgeInputs.AvaOperational || inputName === AvaGatewayEdgeInputs.AvaDiagnostics) {
                            await avaInferenceDevice.sendAvaEvent(AvaPipeline.getAvaMessageProperty(message, 'eventType'), messageJson);
                        }
                        else {
                            await avaInferenceDevice.processAvaInferences(messageJson.inferences);
                        }
                    }

                    break;
                }

                default:
                    this.server.log([ModuleName, 'warning'], `Warning: received routed message for unknown input: ${inputName}`);
                    break;
            }
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Error while handling downstream message: ${ex.message}`);
        }
    }

    @bind
    public async onModuleReady(): Promise<void> {
        this.server.log([ModuleName, 'info'], `Starting onModuleReady initializaton`);

        const gatewayConfig = await this.server.settings.app.config.get(GatewayConfig) as IConfigureGatewayCommandRequestParmas;
        await this.configureGateway(gatewayConfig);

        this.healthCheckRetries = Number(process.env.healthCheckRetries) || defaultHealthCheckRetries;
        this.healthState = this.iotCentralPluginModule.moduleClient ? HealthState.Good : HealthState.Critical;

        const systemProperties = await this.getSystemProperties();

        this.iotCentralPluginModule.addDirectMethod(AvaGatewayCapability.cmConfigureGateway, this.handleDirectMethod);
        this.iotCentralPluginModule.addDirectMethod(AvaGatewayCapability.cmDiscoverOnvifCameras, this.handleDirectMethod);
        this.iotCentralPluginModule.addDirectMethod(AvaGatewayCapability.cmGetCameraDevices, this.handleDirectMethod);
        this.iotCentralPluginModule.addDirectMethod(AvaGatewayCapability.cmAddOnvifCameraDevice, this.handleDirectMethod);
        this.iotCentralPluginModule.addDirectMethod(AvaGatewayCapability.cmAddCameraDevice, this.handleDirectMethod);
        this.iotCentralPluginModule.addDirectMethod(AvaGatewayCapability.cmDeleteCameraDevice, this.handleDirectMethod);
        this.iotCentralPluginModule.addDirectMethod(AvaGatewayCapability.cmRestartGatewayModule, this.handleDirectMethod);
        this.iotCentralPluginModule.addDirectMethod(AvaGatewayCapability.cmClearDeviceCache, this.handleDirectMethod);
        this.iotCentralPluginModule.addDirectMethod(AvaGatewayCapability.cmClearPipelineCache, this.handleDirectMethod);

        await this.iotCentralPluginModule.updateModuleProperties({
            [IotcEdgeHostDevicePropNames.ProcessorArchitecture]: osArch() || 'Unknown',
            [IotcEdgeHostDevicePropNames.Hostname]: osHostname() || 'Unknown',
            [IotcEdgeHostDevicePropNames.Platform]: osPlatform() || 'Unknown',
            [IotcEdgeHostDevicePropNames.OsType]: osType() || 'Unknown',
            [IotcEdgeHostDevicePropNames.OsName]: osRelease() || 'Unknown',
            [IotcEdgeHostDevicePropNames.TotalMemory]: systemProperties.totalMemory || 0,
            [IotcEdgeHostDevicePropNames.SwVersion]: osVersion() || 'Unknown'
        });

        await this.iotCentralPluginModule.sendMeasurement({
            [AvaGatewayCapability.stIoTCentralClientState]: IoTCentralClientState.Connected,
            [AvaGatewayCapability.stModuleState]: ModuleState.Active,
            [AvaGatewayCapability.evModuleStarted]: 'Module initialization'
        }, IotcOutputName);

        await this.recreateCachedDevices();
    }

    public async createCamera(cameraInfo: ICameraProvisionInfo): Promise<IDeviceOperationResult> {
        const provisionResult = await this.createAvaInferenceDevice(cameraInfo);
        return {
            status: provisionResult.dpsProvisionStatus === true && provisionResult.clientConnectionStatus === true,
            message: provisionResult.dpsProvisionMessage || provisionResult.clientConnectionMessage
        };
    }

    public async deleteCamera(cameraOperationInfo: ICameraOperationInfo): Promise<IDeviceOperationResult> {
        return this.avaInferenceDeviceOperation('DELETE_CAMERA', cameraOperationInfo);
    }

    public async sendCameraTelemetry(cameraOperationInfo: ICameraOperationInfo): Promise<IDeviceOperationResult> {
        return this.avaInferenceDeviceOperation('SEND_EVENT', cameraOperationInfo);
    }

    public async sendCameraInferences(cameraOperationInfo: ICameraOperationInfo): Promise<IDeviceOperationResult> {
        return this.avaInferenceDeviceOperation('SEND_INFERENCES', cameraOperationInfo);
    }

    @bind
    public async getHealth(): Promise<HealthState> {
        if (!this.iotCentralPluginModule) {
            return this.healthState;
        }

        let healthState = this.healthState;

        try {
            if (healthState === HealthState.Good) {
                const healthTelemetry = {};
                const systemProperties = await this.getSystemProperties();
                const freeMemory = systemProperties?.freeMemory || 0;

                healthTelemetry[AvaGatewayCapability.tlFreeMemory] = freeMemory;
                healthTelemetry[AvaGatewayCapability.tlConnectedCameras] = this.avaInferenceDeviceMap.size;

                // TODO:
                // Find the right threshold for this metric
                if (freeMemory === 0) {
                    healthState = HealthState.Critical;
                }

                healthTelemetry[AvaGatewayCapability.tlSystemHeartbeat] = healthState;

                await this.iotCentralPluginModule.sendMeasurement(healthTelemetry, IotcOutputName);
            }

            this.healthState = healthState;

            for (const device of this.avaInferenceDeviceMap) {
                forget(device[1].getHealth);
            }
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Error in healthState (may indicate a critical issue): ${ex.message}`);
            this.healthState = HealthState.Critical;
        }

        if (this.healthState < HealthState.Good) {
            this.server.log([ModuleName, 'warning'], `Health check warning: ${HealthState[healthState]}`);

            if (++this.healthCheckFailStreak >= this.healthCheckRetries) {
                this.server.log([ModuleName, 'warning'], `Health check too many warnings: ${healthState}`);

                await this.restartModule(0, 'checkHealthState');
            }
        }

        return this.healthState;
    }

    private checkModuleConfig(): { result: boolean; message: string } {
        return {
            result: !!(this.moduleConfig.appSubDomain
                && this.moduleConfig.appBaseDomain
                && this.moduleConfig.apiToken
                && this.moduleConfig.deviceKey
                && this.moduleConfig.scopeId),
            message: `Missing required module configuration parameters (appSubDomain, appBaseDomain, apiToken, deviceKey, scopeId)`
        };
    }

    private async configureGateway(gatewayConfiguration: IConfigureGatewayCommandRequestParmas): Promise<ModuleCommandResponse> {
        this.server.log([ModuleName, 'info'], `configureGateway`);

        const response: ModuleCommandResponse = {
            statusCode: 200,
            message: `Gateway configuration completed successfully`
        };

        try {
            await this.iotCentralPluginModule.sendMeasurement({
                [AvaGatewayCapability.evConfigureGateway]: ''
            });

            if (!gatewayConfiguration?.moduleConfig?.appSubDomain
                || !gatewayConfiguration?.moduleConfig?.appBaseDomain
                || !gatewayConfiguration?.moduleConfig?.apiToken
                || !gatewayConfiguration?.moduleConfig?.deviceKey
                || !gatewayConfiguration?.moduleConfig?.scopeId) {

                response.statusCode = 400;
                response.message = `Required gateway configuration parameters are missing`;

                this.server.log([ModuleName, 'error'], response.message);
            }
            else {
                this.moduleConfig = {
                    dpsProvisioningHost: gatewayConfiguration.moduleConfig?.dpsProvisioningHost || process.env.dpsProvisioningHost || defaultDpsProvisioningHost,
                    avaOnvifCameraModelId: gatewayConfiguration.moduleConfig?.avaOnvifCameraModelId || process.env.avaOnvifCameraModelId || defaultAvaOnvifCameraModelId,
                    ...gatewayConfiguration.moduleConfig
                };

                const blobStorageConfig = {
                    blobConnectionString: gatewayConfiguration?.blobStorage?.blobConnectionString || '',
                    blobPipelineContainer: gatewayConfiguration?.blobStorage?.blobPipelineContainer || '',
                    blobImageCaptureContainer: gatewayConfiguration?.blobStorage?.blobImageCaptureContainer || ''
                };

                if (blobStorageConfig.blobConnectionString
                    && blobStorageConfig.blobPipelineContainer
                    && blobStorageConfig.blobImageCaptureContainer) {

                    if (!(await this.server.settings.app.blobStorage.configureBlobStorageClient(blobStorageConfig))) {
                        this.server.log([ModuleName, 'error'], `An error occurred while trying to configure the blob storage client`);
                    }
                }
                else {
                    this.server.log([ModuleName, 'info'], `All optional blob storage configuration values were not found`);
                }

                await this.server.settings.app.config.set(GatewayConfig, {
                    moduleConfig: this.moduleConfig,
                    blobStorage: blobStorageConfig
                });
            }
        }
        catch (ex) {
            response.statusCode = 500;
            response.message = `An error occurred while setting the gateway configuration: ${ex.message}`;

            this.server.log([ModuleName, 'error'], response.message);
        }

        return response;
    }

    private async discoverCameras(scanTimeout: number): Promise<ModuleCommandResponse> {
        this.server.log([ModuleName, 'info'], `scanForCameras`);

        const response: ModuleCommandResponse = {
            statusCode: 200,
            message: `Camera discovery completed successfully`,
            payload: []
        };

        try {
            this.server.log([ModuleName, 'info'], 'Initiating Onvif camera discovery');
            await this.iotCentralPluginModule.sendMeasurement({
                [AvaGatewayCapability.evCameraDiscoveryInitiated]: ''
            });

            const requestParams = {
                timeout: scanTimeout <= 0 || scanTimeout > 60 ? 5000 : scanTimeout * 1000
            };

            const scanForCamerasResult = await this.iotCentralPluginModule.invokeDirectMethod(
                this.server.settings.app.cameraGateway.moduleEnvironmentConfig.onvifModuleId,
                'Discover',
                requestParams);

            // Sample response:
            // {
            //     Id: 'urn:uuid:4cf1c000-7442-11b2-806e-f84dfcaba9b7',
            //     Name: 'HIKVISION DS-2CD2185FWD-I',
            //     Hardware: 'DS-2CD2185FWD-I',
            //     RemoteAddress: '10.10.16.137',
            //     Location: '',
            //     Xaddrs: [
            //         'http://10.10.16.137/onvif/device_service',
            //         'http://[fddc:92d3:8a5b:1:fa4d:fcff:feab:a9b7]/onvif/device_service'
            //     ],
            //     ScopeUris: [
            //         'onvif://www.onvif.org/type/video_encoder',
            //         'onvif://www.onvif.org/Profile/Streaming',
            //         'onvif://www.onvif.org/Profile/G',
            //         'onvif://www.onvif.org/Profile/T',
            //         'onvif://www.onvif.org/hardware/DS-2CD2185FWD-I',
            //         'onvif://www.onvif.org/name/HIKVISION DS-2CD2185FWD-I'
            //     ]
            // }

            this.server.log([ModuleName, 'info'], 'Onvif camera discovery complete');
            await this.iotCentralPluginModule.sendMeasurement({
                [AvaGatewayCapability.evCameraDiscoveryCompleted]: ''
            });


            if (scanForCamerasResult.status >= 200 && scanForCamerasResult.status < 300) {
                response.payload = (scanForCamerasResult.payload as any[] || []).map((cameraResult) => {
                    return {
                        name: cameraResult?.Name || '',
                        hardware: cameraResult?.Hardware || '',
                        ipAddress: cameraResult?.RemoteAddress || '',
                        profiles: (cameraResult?.ScopeUris || []).map((scope) => {
                            const scopePath = new URL(scope);
                            const profilePathIndex = scopePath.pathname.indexOf('Profile/');
                            if (profilePathIndex >= 0) {
                                return scopePath.pathname.substring(profilePathIndex + 8);
                            }
                        }).filter(Boolean)
                    };
                });
            }
            else {
                response.statusCode = 500;
                response.message = `An error occurred during the Onvif discover operation`;

                this.server.log([ModuleName, 'error'], response.message);
            }
        }
        catch (ex) {
            response.statusCode = 500;
            response.message = `An error occurred during the Onvif discover operation: ${ex.message}`;

            this.server.log([ModuleName, 'error'], response.message);
        }

        return response;
    }

    private async getCameras(): Promise<ModuleCommandResponse> {
        this.server.log([ModuleName, 'info'], `getCameras`);

        const response: ModuleCommandResponse = {
            statusCode: 200,
            message: `Get camera list succeeded`,
            payload: []
        };

        for (const device of this.avaInferenceDeviceMap) {
            const currentDevice = device[1];
            const cameraProvisionInfo = currentDevice.cameraProvisionInfo;
            const cameraProperties = currentDevice.cameraDeviceInformation;

            response.payload.push({
                name: cameraProvisionInfo.cameraName,
                id: cameraProvisionInfo.cameraId,
                ipAddress: cameraProvisionInfo.ipAddress,
                processingState: currentDevice.processingState,
                avaPipelineTopologyName: currentDevice.avaPipelineTopologyName,
                avaLivePipelineName: currentDevice.avaLivePipelineName,
                ...cameraProperties
            });
        }

        return response;
    }

    private async restartModule(timeout: number, reason: string): Promise<void> {
        this.server.log([ModuleName, 'info'], `restartModule`);

        try {
            await this.iotCentralPluginModule.sendMeasurement({
                [AvaGatewayCapability.evModuleRestart]: reason,
                [AvaGatewayCapability.stModuleState]: ModuleState.Inactive,
                [AvaGatewayCapability.evModuleStopped]: 'Module restart'
            }, IotcOutputName);

            await sleep(1000 * timeout);
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `${ex.message}`);
        }

        // let Docker restart our container after 5 additional seconds to allow responses to this method to return
        setTimeout(() => {
            this.server.log([ModuleName, 'info'], `Shutting down main process - module container will restart`);
            process.exit(1);
        }, 1000 * 5);
    }

    private async getSystemProperties(): Promise<ISystemProperties> {
        const cpus = osCpus();
        const cpuUsageSamples = osLoadAvg();

        return {
            cpuModel: cpus[0]?.model || 'Unknown',
            cpuCores: cpus?.length || 0,
            cpuUsage: cpuUsageSamples[0],
            totalMemory: osTotalMem() / 1024,
            freeMemory: osFreeMem() / 1024
        };
    }

    private async createAvaInferenceDevice(cameraInfo: ICameraProvisionInfo, dpsConnectionString?: string): Promise<IProvisionResult> {
        this.server.log([ModuleName, 'info'], `createAvaInferenceDevice`);

        let deviceProvisionResult: IProvisionResult = {
            dpsProvisionStatus: false,
            dpsProvisionMessage: '',
            dpsHubConnectionString: '',
            clientConnectionStatus: false,
            clientConnectionMessage: '',
            avaInferenceDevice: null
        };

        try {
            if (!cameraInfo.cameraId
                || !cameraInfo.cameraName
                || !cameraInfo.ipAddress
                || !cameraInfo.username
                || !cameraInfo.password) {

                deviceProvisionResult.dpsProvisionStatus = false;
                deviceProvisionResult.dpsProvisionMessage = `Missing device configuration - skipping DPS provisioning`;

                this.server.log([ModuleName, 'error'], deviceProvisionResult.dpsProvisionMessage);

                return deviceProvisionResult;
            }

            if (!cameraInfo?.isOnvifCamera && !cameraInfo?.plainCameraInformation?.rtspVideoStream) {
                deviceProvisionResult.dpsProvisionStatus = false;
                deviceProvisionResult.dpsProvisionMessage = `Missing RTSP video stream url for plain camera - skipping DPS provisioning`;

                this.server.log([ModuleName, 'error'], deviceProvisionResult.dpsProvisionMessage);

                return deviceProvisionResult;
            }

            this.server.log([ModuleName, 'info'], `createAvaInferenceDevice - cameraId: ${cameraInfo.cameraId}, cameraName: ${cameraInfo.cameraName}`);

            const configCheck = this.checkModuleConfig();
            if (!configCheck.result) {
                deviceProvisionResult.dpsProvisionStatus = false;
                deviceProvisionResult.dpsProvisionMessage = configCheck.message;
                this.server.log([ModuleName, 'error'], deviceProvisionResult.dpsProvisionMessage);

                return deviceProvisionResult;
            }

            deviceProvisionResult = await this.createAndProvisionAvaInferenceDevice(cameraInfo, dpsConnectionString);

            if (deviceProvisionResult.dpsProvisionStatus && deviceProvisionResult.clientConnectionStatus) {
                this.avaInferenceDeviceMap.set(cameraInfo.cameraId, deviceProvisionResult.avaInferenceDevice);

                await this.iotCentralPluginModule.sendMeasurement({
                    [AvaGatewayCapability.evCreateCamera]: cameraInfo.cameraId
                }, IotcOutputName);

                this.server.log([ModuleName, 'info'], `Succesfully provisioned camera device with id: ${cameraInfo.cameraId}`);

                await this.updateCachedDeviceInfo(
                    DeviceCacheOperation.Update,
                    cameraInfo.cameraId,
                    {
                        cameraInfo,
                        dpsConnectionString: deviceProvisionResult.dpsHubConnectionString
                    });
            }
        }
        catch (ex) {
            deviceProvisionResult.dpsProvisionStatus = false;
            deviceProvisionResult.dpsProvisionMessage = `Error while provisioning avaInferenceDevice: ${ex.message}`;

            this.server.log([ModuleName, 'error'], deviceProvisionResult.dpsProvisionMessage);
        }

        return deviceProvisionResult;
    }

    private async createAndProvisionAvaInferenceDevice(cameraInfo: ICameraProvisionInfo, cachedDpsConnectionString?: string): Promise<IProvisionResult> {
        this.server.log([ModuleName, 'info'], `Provisioning device - id: ${cameraInfo.cameraId}`);

        const deviceProvisionResult: IProvisionResult = {
            dpsProvisionStatus: false,
            dpsProvisionMessage: '',
            dpsHubConnectionString: '',
            clientConnectionStatus: false,
            clientConnectionMessage: '',
            avaInferenceDevice: null
        };

        try {
            let dpsConnectionString = cachedDpsConnectionString;

            if (!dpsConnectionString) {
                const deviceKey = this.computeDeviceKey(cameraInfo.cameraId, this.moduleConfig.deviceKey);

                const provisioningSecurityClient = new SymmetricKeySecurityClient(cameraInfo.cameraId, deviceKey);
                const provisioningClient = ProvisioningDeviceClient.create(
                    this.moduleConfig.dpsProvisioningHost,
                    this.moduleConfig.scopeId,
                    new ProvisioningTransport(),
                    provisioningSecurityClient);

                const provisioningPayload = {
                    iotcModelId: this.moduleConfig.avaOnvifCameraModelId,
                    iotcGateway: {
                        iotcGatewayId: this.iotCentralPluginModule.deviceId,
                        iotcModuleId: this.iotCentralPluginModule.moduleId
                    }
                };

                provisioningClient.setProvisioningPayload(provisioningPayload);
                this.server.log([ModuleName, 'info'], `setProvisioningPayload succeeded ${JSON.stringify(provisioningPayload, null, 4)}`);

                const dpsResult = await provisioningClient.register();

                dpsConnectionString = `HostName=${(dpsResult as RegistrationResult).assignedHub};DeviceId=${(dpsResult as RegistrationResult).deviceId};SharedAccessKey=${deviceKey}`;

                this.server.log([ModuleName, 'info'], `register device client succeeded`);
            }

            deviceProvisionResult.dpsProvisionStatus = true;
            deviceProvisionResult.dpsProvisionMessage = `IoT Central successfully provisioned device: ${cameraInfo.cameraId}`;
            deviceProvisionResult.dpsHubConnectionString = dpsConnectionString;

            deviceProvisionResult.avaInferenceDevice = new AvaCameraDevice(this.server, this.moduleConfig.scopeId, cameraInfo);

            const { clientConnectionStatus, clientConnectionMessage } = await deviceProvisionResult.avaInferenceDevice.connectDeviceClient(deviceProvisionResult.dpsHubConnectionString);

            this.server.log([ModuleName, 'info'], `clientConnectionStatus: ${clientConnectionStatus}, clientConnectionMessage: ${clientConnectionMessage}`);

            deviceProvisionResult.clientConnectionStatus = clientConnectionStatus;
            deviceProvisionResult.clientConnectionMessage = clientConnectionMessage;
        }
        catch (ex) {
            deviceProvisionResult.dpsProvisionStatus = false;
            deviceProvisionResult.dpsProvisionMessage = `Error while provisioning device: ${ex.message}`;

            this.server.log([ModuleName, 'error'], deviceProvisionResult.dpsProvisionMessage);
        }

        return deviceProvisionResult;
    }

    private async deprovisionAvaInferenceDevice(cameraId: string): Promise<ModuleCommandResponse> {
        this.server.log([ModuleName, 'info'], `Deprovisioning device - id: ${cameraId}`);

        const response: ModuleCommandResponse = {
            statusCode: 200,
            message: `Finished deprovisioning camera device ${cameraId}`
        };

        const configCheck = this.checkModuleConfig();
        if (!configCheck.result) {
            response.statusCode = 400;
            response.message = configCheck.message;

            return response;
        }

        try {
            const avaInferenceDevice = this.avaInferenceDeviceMap.get(cameraId);
            if (avaInferenceDevice) {
                await avaInferenceDevice.deleteCamera();
                this.avaInferenceDeviceMap.delete(cameraId);
            }

            await this.updateCachedDeviceInfo(DeviceCacheOperation.Delete, cameraId);

            this.server.log([ModuleName, 'info'], `Deleting IoT Central device instance: ${cameraId}`);
            try {
                await this.iotcApiRequest(
                    `https://${this.moduleConfig.appSubDomain}.${this.moduleConfig.appBaseDomain}/api/preview/devices/${cameraId}`,
                    'delete',
                    {
                        headers: {
                            Authorization: this.moduleConfig.apiToken
                        },
                        json: true
                    });

                await this.iotCentralPluginModule.sendMeasurement({
                    [AvaGatewayCapability.evDeleteCamera]: cameraId
                }, IotcOutputName);

                this.server.log([ModuleName, 'info'], `Succesfully de-provisioned camera device with id: ${cameraId}`);
            }
            catch (ex) {
                response.statusCode = 500;
                response.message = `Request to delete the IoT Central device failed: ${ex.message}`;

                this.server.log([ModuleName, 'error'], response.message);
            }
        }
        catch (ex) {
            response.statusCode = 500;
            response.message = `Failed to de-provision device: ${ex.message}`;

            this.server.log([ModuleName, 'error'], response.message);
        }

        return response;
    }

    private computeDeviceKey(deviceId: string, masterKey: string) {
        return crypto.createHmac('SHA256', Buffer.from(masterKey, 'base64')).update(deviceId, 'utf8').digest('base64');
    }

    private async recreateCachedDevices() {
        this.server.log([ModuleName, 'info'], 'Recreate devices using cached device information');

        try {
            const deviceCache = await this.server.settings.app.config.get(DeviceCache);
            const cachedDeviceList: IDeviceCacheInfo[] = deviceCache?.cache || [];

            this.server.log([ModuleName, 'info'], `Found ${cachedDeviceList.length} cached devices`);
            if (this.debugTelemetry()) {
                this.server.log([ModuleName, 'info'], `${JSON.stringify(cachedDeviceList, null, 4)}`);
            }

            for (const cachedDevice of cachedDeviceList) {
                let retryProvisioning = false;

                try {
                    const provisionResult = await this.createAvaInferenceDevice(cachedDevice.cameraInfo, cachedDevice.dpsConnectionString);
                    if (!provisionResult.dpsProvisionStatus || !provisionResult.clientConnectionStatus) {
                        this.server.log([ModuleName, 'warning'], `An error occurred (using cached device info): ${provisionResult.dpsProvisionMessage || provisionResult.clientConnectionMessage}`);

                        retryProvisioning = true;
                    }
                }
                catch (ex) {
                    this.server.log([ModuleName, 'error'], `An error occurred while re-creating the device: ${cachedDevice.cameraInfo.cameraId} - ${ex.message}`);
                    retryProvisioning = true;
                }

                if (retryProvisioning) {
                    try {
                        const provisionResult = await this.createAvaInferenceDevice(cachedDevice.cameraInfo);
                        if (!provisionResult.dpsProvisionStatus || !provisionResult.clientConnectionStatus) {
                            this.server.log([ModuleName, 'warning'], `An error occurred (using dps provisioning): ${provisionResult.dpsProvisionMessage || provisionResult.clientConnectionMessage}`);
                        }
                    }
                    catch (ex) {
                        this.server.log([ModuleName, 'error'], `An error occurred while re-creating the device: ${cachedDevice.cameraInfo.cameraId} - ${ex.message}`);
                        retryProvisioning = true;
                    }
                }
            }
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Failed to get device list: ${ex.message}`);
        }

        // If there were errors, we may be in a bad state (e.g. an ava inference device exists
        // but we were not able to re-connect to it's client interface). Consider setting the health
        // state to critical here to restart the gateway module.
    }

    private async updateCachedDeviceInfo(operation: DeviceCacheOperation, cameraId: string, cacheProvisionInfo?: IDeviceCacheInfo): Promise<void> {
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
                            dpsConnectionString: cacheProvisionInfo.dpsConnectionString
                        });
                    }
                    else {
                        cachedDeviceList[cachedDeviceIndex] = {
                            ...cacheProvisionInfo
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

    private async avaInferenceDeviceOperation(deviceOperation: DeviceOperation, cameraOperationInfo: ICameraOperationInfo): Promise<IDeviceOperationResult> {
        this.server.log([ModuleName, 'info'], `Processing AVA Edge gateway operation: ${JSON.stringify(cameraOperationInfo, null, 4)}`);

        const operationResult = {
            status: false,
            message: ''
        };

        const cameraId = cameraOperationInfo?.cameraId;
        if (!cameraId) {
            operationResult.message = `Missing cameraId`;

            this.server.log([ModuleName, 'error'], operationResult.message);

            return operationResult;
        }

        const avaInferenceDevice = this.avaInferenceDeviceMap.get(cameraId);
        if (!avaInferenceDevice) {
            operationResult.message = `No device exists with cameraId: ${cameraId}`;

            this.server.log([ModuleName, 'error'], operationResult.message);

            return operationResult;
        }

        const operationInfo = cameraOperationInfo?.operationInfo;
        if (!operationInfo) {
            operationResult.message = `Missing operationInfo data`;

            this.server.log([ModuleName, 'error'], operationResult.message);

            return operationResult;
        }

        switch (deviceOperation) {
            case 'DELETE_CAMERA':
                await this.deprovisionAvaInferenceDevice(cameraId);
                break;

            case 'SEND_EVENT':
                await avaInferenceDevice.sendAvaEvent(operationInfo);
                break;

            case 'SEND_INFERENCES':
                await avaInferenceDevice.processAvaInferences(operationInfo);
                break;

            default:
                this.server.log([ModuleName, 'error'], `Unkonwn device operation: ${deviceOperation}`);
                break;
        }

        return {
            status: true,
            message: `Success`
        };
    }

    @bind
    private async handleDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log([ModuleName, 'info'], `${commandRequest.methodName} command received`);

        let response: ModuleCommandResponse = {
            statusCode: 200,
            message: ''
        };

        try {
            switch (commandRequest.methodName) {
                case AvaGatewayCapability.cmConfigureGateway: {
                    response = await this.configureGateway(commandRequest?.payload);
                    break;
                }

                case AvaGatewayCapability.cmDiscoverOnvifCameras: {
                    response = await this.discoverCameras((commandRequest?.payload as IDiscoverCamerasCommandRequestParams)?.timeout || 0);
                    break;
                }

                case AvaGatewayCapability.cmGetCameraDevices: {
                    response = await this.getCameras();
                    break;
                }

                case AvaGatewayCapability.cmAddCameraDevice: {
                    const provisionResult = await this.createAvaInferenceDevice(commandRequest?.payload);

                    response.statusCode = (provisionResult.dpsProvisionStatus && provisionResult.clientConnectionStatus) ? 200 : 400;
                    response.message = provisionResult.clientConnectionMessage || provisionResult.dpsProvisionMessage;

                    break;
                }

                case AvaGatewayCapability.cmDeleteCameraDevice: {
                    const cameraId = (commandRequest?.payload as IDeleteCameraCommandRequestParams)?.cameraId;
                    if (!cameraId) {
                        response.statusCode = 400;
                        response.message = `Missing required Camera Id parameter`;
                    }
                    else {
                        response = await this.deprovisionAvaInferenceDevice(cameraId);
                    }

                    break;
                }

                case AvaGatewayCapability.cmRestartGatewayModule:
                    await this.restartModule((commandRequest?.payload as IRestartGatewayModuleCommandRequestParams)?.timeout || 0, 'RestartModule command received');

                    response.statusCode = 200;
                    response.message = 'Restart module request received';
                    break;

                case AvaGatewayCapability.cmClearDeviceCache:
                    await this.server.settings.app.config.set(DeviceCache, {});

                    response.statusCode = 200;
                    response.message = `The device cache was cleared`;
                    break;

                case AvaGatewayCapability.cmClearPipelineCache: {
                    const clearResult = await this.server.settings.app.config.clear(PipelineCache);
                    if (clearResult) {
                        response.statusCode = 200;
                        response.message = `The pipeline cache was cleared`;
                    }
                    else {
                        response.statusCode = 500;
                        response.message = `An error occured while attempting to clear the pipeline cache`;
                    }

                    break;
                }

                default:
                    response.statusCode = 400;
                    response.message = `An unknown method name was found: ${commandRequest.methodName}`;
            }

            this.server.log([ModuleName, 'info'], response.message);
        }
        catch (ex) {
            response.statusCode = 500;
            response.message = `An error occurred executing the command ${commandRequest.methodName}: ${ex.message}`;

            this.server.log([ModuleName, 'error'], response.message);
        }

        await commandResponse.send(200, response);
    }

    private async iotcApiRequest(uri, method, options): Promise<any> {
        try {
            const iotcApiResponse = await Wreck[method](uri, options);

            if (iotcApiResponse.res.statusCode < 200 || iotcApiResponse.res.statusCode > 299) {
                this.server.log([ModuleName, 'error'], `Response status code = ${iotcApiResponse.res.statusCode}`);

                throw new Error((iotcApiResponse.payload as any)?.message || iotcApiResponse.payload || 'An error occurred');
            }

            return iotcApiResponse;
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `iotcApiRequest: ${ex.message}`);
            throw ex;
        }
    }
}
