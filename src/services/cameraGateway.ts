import { service, inject } from 'spryly';
import { Server } from '@hapi/hapi';
import { HealthState } from './health';
import { AvaPipeline } from './avaPipeline';
import {
    IOnlineCameraInformation,
    AvaCameraDevice
} from './device';
import { SymmetricKeySecurityClient } from 'azure-iot-security-symmetric-key';
import { RegistrationResult, ProvisioningDeviceClient } from 'azure-iot-provisioning-device';
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
import { blobStoragePlugin } from '../plugins/blobStorage';
import { bind, emptyObj, forget } from '../utils';

const ModuleName = 'CameraGatewayService';
const IotcOutputName = 'iotc';
const defaultHealthCheckRetries = 3;
const defaultDpsProvisioningHost = 'global.azure-devices-provisioning.net';
const defaultDeviceModelId = 'dtmi:com:azuremedia:model:AvaEdgeDevice;1';

const DeviceCache = 'deviceCache';
export const PipelineCache = 'pipelines';

type DeviceOperation = 'DELETE_CAMERA' | 'SEND_EVENT' | 'SEND_INFERENCES';

interface IEnvConfig {
    onvifModuleId: string;
    avaEdgeModuleId: string;
}

interface IAppConfig {
    appSubDomain: string;
    appBaseDomain: string;
    apiToken: string;
    deviceKey: string;
    scopeId: string;
    dpsProvisioningHost: string;
    deviceModelId: string;
}

export interface ICameraProvisionInfo {
    cameraId: string;
    cameraName: string;
    ipAddress: string;
    onvifUsername: string;
    onvifPassword: string;
}

interface ICameraOperationInfo {
    cameraId: string;
    operationInfo: any;
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
    iotCentral: {
        appSubDomain: string;
        appBaseDomain: string;
        apiToken: string;
        deviceKey: string;
        scopeId: string;
        dpsProvisioningHost: string;
        deviceModelId: string;
    };
    blobStorage: {
        blobConnectionString: string;
        blobPipelineContainer: string;
        blobImageCaptureContainer: string;
    };
}

enum DiscoverCamerasCommandRequestParams {
    Timeout = 'DiscoverOnvifCamerasRequestParams_Timeout'
}

enum AddCameraCommandRequestParams {
    CameraId = 'AddCameraRequestParams_CameraId',
    CameraName = 'AddCameraRequestParams_CameraName',
    IpAddress = 'AddCameraRequestParams_IpAddress',
    OnvifUsername = 'AddCameraRequestParams_OnvifUsername',
    OnvifPassword = 'AddCameraRequestParams_OnvifPassword'
}

enum RestartGatewayModuleCommandRequestParams {
    Timeout = 'RestartGatewayModuleRequestParams_Timeout'
}

enum DeleteCameraCommandRequestParams {
    CameraId = 'DeleteCameraRequestParams_CameraId'
}

enum CommandResponseParams {
    StatusCode = 'CommandResponseParams_StatusCode',
    Message = 'CommandResponseParams_Message',
    Data = 'CommandResponseParams_Data'
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
    CreateCamera: 'createcamera',
    DeleteCamera: 'deletecamera',
    SendDeviceTelemetry: 'senddevicetelemetry',
    SendDeviceInferences: 'senddeviceinferences'
};

@service('cameraGateway')
export class CameraGatewayService {
    @inject('$server')
    private server: Server;

    private envConfigInternal: IEnvConfig = {
        onvifModuleId: process.env.onvifModuleId || '',
        avaEdgeModuleId: process.env.avaEdgeModuleId || ''
    };

    private healthCheckRetries: number = defaultHealthCheckRetries;
    private healthState = HealthState.Good;
    private healthCheckFailStreak = 0;
    private moduleSettings: IAvaGatewaySettings = {
        [AvaGatewayCapability.wpDebugTelemetry]: false,
        [AvaGatewayCapability.wpDebugRoutedMessage]: false
    };
    private avaInferenceDeviceMap = new Map<string, AvaCameraDevice>();
    private appConfig: IAppConfig;
    private dpsProvisioningHost: string;
    private deviceModelId: string;

    public get envConfig(): IEnvConfig {
        return this.envConfigInternal;
    }

    public async init(): Promise<void> {
        this.server.log([ModuleName, 'info'], 'initialize');
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
                await this.server.settings.app.iotCentralModule.updateModuleProperties(patchedProperties);
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
                        case AvaGatewayCommands.CreateCamera:
                            await this.createAvaInferenceDevice({
                                cameraId: edgeInputCameraCommandData?.cameraId,
                                cameraName: edgeInputCameraCommandData?.cameraName,
                                ipAddress: edgeInputCameraCommandData?.ipAddress,
                                onvifUsername: edgeInputCameraCommandData?.onvifUsername,
                                onvifPassword: edgeInputCameraCommandData?.onvifPassword
                            });
                            break;

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

        this.appConfig = await this.server.settings.app.config.get('state', 'iotCentral');
        this.dpsProvisioningHost = this.appConfig?.dpsProvisioningHost || process.env.dpsProvisioningHost || defaultDpsProvisioningHost;
        this.deviceModelId = this.appConfig?.deviceModelId || process.env.deviceModelId || defaultDeviceModelId;

        this.healthCheckRetries = Number(process.env.healthCheckRetries) || defaultHealthCheckRetries;
        this.healthState = this.server.settings.app.iotCentralModule.getModuleClient() ? HealthState.Good : HealthState.Critical;

        const systemProperties = await this.getSystemProperties();

        this.server.settings.app.iotCentralModule.addDirectMethod(AvaGatewayCapability.cmDiscoverOnvifCameras, this.handleDirectMethod);
        this.server.settings.app.iotCentralModule.addDirectMethod(AvaGatewayCapability.cmGetCameraDevices, this.handleDirectMethod);
        this.server.settings.app.iotCentralModule.addDirectMethod(AvaGatewayCapability.cmAddCameraDevice, this.handleDirectMethod);
        this.server.settings.app.iotCentralModule.addDirectMethod(AvaGatewayCapability.cmDeleteCameraDevice, this.handleDirectMethod);
        this.server.settings.app.iotCentralModule.addDirectMethod(AvaGatewayCapability.cmRestartGatewayModule, this.handleDirectMethod);
        this.server.settings.app.iotCentralModule.addDirectMethod(AvaGatewayCapability.cmClearDeviceCache, this.handleDirectMethod);
        this.server.settings.app.iotCentralModule.addDirectMethod(AvaGatewayCapability.cmClearPipelineCache, this.handleDirectMethod);

        await this.server.settings.app.iotCentralModule.updateModuleProperties({
            [IotcEdgeHostDevicePropNames.ProcessorArchitecture]: osArch() || 'Unknown',
            [IotcEdgeHostDevicePropNames.Hostname]: osHostname() || 'Unknown',
            [IotcEdgeHostDevicePropNames.Platform]: osPlatform() || 'Unknown',
            [IotcEdgeHostDevicePropNames.OsType]: osType() || 'Unknown',
            [IotcEdgeHostDevicePropNames.OsName]: osRelease() || 'Unknown',
            [IotcEdgeHostDevicePropNames.TotalMemory]: systemProperties.totalMemory || 0,
            [IotcEdgeHostDevicePropNames.SwVersion]: osVersion() || 'Unknown'
        });

        await this.server.settings.app.iotCentralModule.sendMeasurement({
            [AvaGatewayCapability.stIoTCentralClientState]: IoTCentralClientState.Connected,
            [AvaGatewayCapability.stModuleState]: ModuleState.Active,
            [AvaGatewayCapability.evModuleStarted]: 'Module initialization'
        }, IotcOutputName);

        await this.recreateCachedDevices();
    }

    public async createCamera(cameraInfo: ICameraProvisionInfo): Promise<IProvisionResult> {
        return this.createAvaInferenceDevice(cameraInfo);
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

                await this.server.settings.app.iotCentralModule.sendMeasurement(healthTelemetry, IotcOutputName);
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

    private async configureGateway(gatewayConfiguration: IConfigureGatewayCommandRequestParmas): Promise<{ result: boolean; payload: any }> {
        this.server.log([ModuleName, 'info'], `configureGateway`);

        let result = true;

        try {
            await this.server.settings.app.iotCentralModule.sendMeasurement({
                [AvaGatewayCapability.evConfigureGateway]: ''
            });

            if (!gatewayConfiguration.iotCentral.appSubDomain
                || !gatewayConfiguration.iotCentral.appBaseDomain
                || !gatewayConfiguration.iotCentral.apiToken
                || !gatewayConfiguration.iotCentral.deviceKey
                || !gatewayConfiguration.iotCentral.scopeId
                || !gatewayConfiguration.blobStorage.blobConnectionString
                || !gatewayConfiguration.blobStorage.blobPipelineContainer
                || !gatewayConfiguration.blobStorage.blobImageCaptureContainer) {

                this.server.log([ModuleName, 'error'], `Required gateway configuration parameters are missing`);
                result = false;
            }
            else {
                this.appConfig = {
                    ...gatewayConfiguration.iotCentral
                };

                await this.server.register([
                    {
                        plugin: blobStoragePlugin,
                        options: gatewayConfiguration.blobStorage
                    }
                ]);
            }
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `An error occurred: ${ex.message}`);
            result = false;
        }

        return {
            result,
            payload: {}
        };
    }

    private async discoverCameras(scanTimeout: number): Promise<{ result: boolean; payload: any[] }> {
        this.server.log([ModuleName, 'info'], `scanForCameras`);

        let result = true;
        let payload = [];

        try {
            this.server.log([ModuleName, 'info'], 'Initiating Onvif camera discovery');
            await this.server.settings.app.iotCentralModule.sendMeasurement({
                [AvaGatewayCapability.evCameraDiscoveryInitiated]: ''
            });

            const requestParams = {
                timeout: scanTimeout <= 0 || scanTimeout > 60 ? 5000 : scanTimeout * 1000
            };

            const scanForCamerasResult = await this.server.settings.app.iotCentralModule.invokeDirectMethod(
                this.envConfig.onvifModuleId,
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
            await this.server.settings.app.iotCentralModule.sendMeasurement({
                [AvaGatewayCapability.evCameraDiscoveryCompleted]: ''
            });


            if (scanForCamerasResult.status >= 200 && scanForCamerasResult.status < 300) {
                payload = (scanForCamerasResult.payload as any[] || []).map((cameraResult) => {
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
                this.server.log([ModuleName, 'error'], `An error occurred during the Onvif discover operation`);
                result = false;
            }
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `An error occurred: ${ex.message}`);
            result = false;
        }

        return {
            result,
            payload
        };
    }

    public async restartModule(timeout: number, reason: string): Promise<void> {
        this.server.log([ModuleName, 'info'], `restartModule`);

        try {
            await this.server.settings.app.iotCentralModule.sendMeasurement({
                [AvaGatewayCapability.evModuleRestart]: reason,
                [AvaGatewayCapability.stModuleState]: ModuleState.Inactive,
                [AvaGatewayCapability.evModuleStopped]: 'Module restart'
            }, IotcOutputName);

            if (timeout > 0) {
                await new Promise((resolve) => {
                    setTimeout(() => {
                        return resolve('');
                    }, 1000 * timeout);
                });
            }
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `${ex.message}`);
        }

        // let Docker restart our container
        this.server.log([ModuleName, 'info'], `Shutting down main process - module container will restart`);
        process.exit(1);
    }

    public async getCameras(): Promise<{ result: boolean; payload: IOnlineCameraInformation[] }> {
        this.server.log([ModuleName, 'info'], `getCameras`);

        const payload: IOnlineCameraInformation[] = [];

        for (const device of this.avaInferenceDeviceMap) {
            const currentDevice = device[1];
            const cameraProvisionInfo = currentDevice.cameraProvisionInfo;
            const onvifCameraInformation = currentDevice.onvifCameraInformation;

            payload.push({
                name: cameraProvisionInfo.cameraName,
                id: cameraProvisionInfo.cameraId,
                ipAddress: cameraProvisionInfo.ipAddress,
                processingState: currentDevice.processingState,
                avaPipelineTopologyName: currentDevice.avaPipelineTopologyName,
                avaLivePipelineName: currentDevice.avaLivePipelineName,
                ...onvifCameraInformation
            });
        }

        return {
            result: true,
            payload
        };
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
        this.server.log([ModuleName, 'info'], `createAvaInferenceDevice - cameraId: ${cameraInfo.cameraId}, cameraName: ${cameraInfo.cameraName}`);

        let deviceProvisionResult: IProvisionResult = {
            dpsProvisionStatus: false,
            dpsProvisionMessage: '',
            dpsHubConnectionString: '',
            clientConnectionStatus: false,
            clientConnectionMessage: '',
            avaInferenceDevice: null
        };

        try {
            if (!cameraInfo.cameraId) {
                deviceProvisionResult.dpsProvisionStatus = false;
                deviceProvisionResult.dpsProvisionMessage = `Missing device configuration - skipping DPS provisioning`;

                this.server.log([ModuleName, 'error'], deviceProvisionResult.dpsProvisionMessage);

                return deviceProvisionResult;
            }

            if (!this.appConfig.appSubDomain
                || !this.appConfig.appBaseDomain
                || !this.appConfig.apiToken
                || !this.appConfig.deviceKey
                || !this.appConfig.scopeId) {

                deviceProvisionResult.dpsProvisionStatus = false;
                deviceProvisionResult.dpsProvisionMessage = `Missing camera management settings (appSubDomain, appBaseDomain, apiToken, deviceKey, scopeId)`;
                this.server.log([ModuleName, 'error'], deviceProvisionResult.dpsProvisionMessage);

                return deviceProvisionResult;
            }

            deviceProvisionResult = await this.createAndProvisionAvaInferenceDevice(cameraInfo, dpsConnectionString);

            if (deviceProvisionResult.dpsProvisionStatus && deviceProvisionResult.clientConnectionStatus) {
                this.avaInferenceDeviceMap.set(cameraInfo.cameraId, deviceProvisionResult.avaInferenceDevice);

                await this.server.settings.app.iotCentralModule.sendMeasurement({
                    [AvaGatewayCapability.evCreateCamera]: cameraInfo.cameraId
                }, IotcOutputName);

                this.server.log([ModuleName, 'info'], `Succesfully provisioned camera device with id: ${cameraInfo.cameraId}`);

                await this.updateCachedDeviceInfo({
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
                const deviceKey = this.computeDeviceKey(cameraInfo.cameraId, this.appConfig.deviceKey);

                const provisioningSecurityClient = new SymmetricKeySecurityClient(cameraInfo.cameraId, deviceKey);
                const provisioningClient = ProvisioningDeviceClient.create(
                    this.dpsProvisioningHost,
                    this.appConfig.scopeId,
                    new ProvisioningTransport(),
                    provisioningSecurityClient);

                const provisioningPayload = {
                    iotcModelId: this.deviceModelId,
                    iotcGateway: {
                        iotcGatewayId: this.server.settings.app.iotCentralModule.deviceId,
                        iotcModuleId: this.server.settings.app.iotCentralModule.moduleId
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

            deviceProvisionResult.avaInferenceDevice = new AvaCameraDevice(
                this.server,
                this.envConfig.onvifModuleId,
                this.envConfig.avaEdgeModuleId,
                this.appConfig.scopeId,
                cameraInfo
            );

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

    private async deprovisionAvaInferenceDevice(cameraId: string): Promise<boolean> {
        this.server.log([ModuleName, 'info'], `Deprovisioning device - id: ${cameraId}`);

        let result = false;

        try {
            const avaInferenceDevice = this.avaInferenceDeviceMap.get(cameraId);
            if (avaInferenceDevice) {
                await avaInferenceDevice.deleteCamera();
                this.avaInferenceDeviceMap.delete(cameraId);
            }

            await this.deleteCachedDeviceInfo(cameraId);

            this.server.log([ModuleName, 'info'], `Deleting IoT Central device instance: ${cameraId}`);
            try {
                await this.iotcApiRequest(
                    `https://${this.appConfig.appSubDomain}.${this.appConfig.appBaseDomain}/api/preview/devices/${cameraId}`,
                    'delete',
                    {
                        headers: {
                            Authorization: this.appConfig.apiToken
                        },
                        json: true
                    });

                await this.server.settings.app.iotCentralModule.sendMeasurement({
                    [AvaGatewayCapability.evDeleteCamera]: cameraId
                }, IotcOutputName);

                this.server.log([ModuleName, 'info'], `Succesfully de-provisioned camera device with id: ${cameraId}`);

                result = true;
            }
            catch (ex) {
                this.server.log([ModuleName, 'error'], `Requeset to delete the IoT Central device failed: ${ex.message}`);
            }
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Failed de-provision device: ${ex.message}`);
        }

        return result;
    }

    private computeDeviceKey(deviceId: string, masterKey: string) {
        return crypto.createHmac('SHA256', Buffer.from(masterKey, 'base64')).update(deviceId, 'utf8').digest('base64');
    }

    private async recreateCachedDevices() {
        this.server.log([ModuleName, 'info'], 'recreateExistingDevices');

        try {
            const deviceCache = await this.server.settings.app.config.get(DeviceCache);
            const cachedDeviceList: IDeviceCacheInfo[] = deviceCache.cache || [];

            this.server.log([ModuleName, 'info'], `Found ${cachedDeviceList.length} cached devices`);
            if (this.debugTelemetry()) {
                this.server.log([ModuleName, 'info'], `${JSON.stringify(cachedDeviceList, null, 4)}`);
            }

            for (const cachedDevice of cachedDeviceList) {
                try {
                    await this.createAvaInferenceDevice(cachedDevice.cameraInfo, cachedDevice.dpsConnectionString);
                }
                catch (ex) {
                    this.server.log([ModuleName, 'error'], `An error occurred while re-creating devices: ${ex.message}`);
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

    private async updateCachedDeviceInfo(cacheProvisionInfo: IDeviceCacheInfo): Promise<void> {
        try {
            const { cachedDeviceList, cachedDeviceIndex } = await this.getCachedDeviceList(cacheProvisionInfo.cameraInfo.cameraId);
            if (cachedDeviceIndex === -1) {
                cachedDeviceList.push(cacheProvisionInfo);
            }
            else {
                cachedDeviceList[cachedDeviceIndex] = {
                    ...cacheProvisionInfo
                };
            }

            await this.server.settings.app.config.set(DeviceCache, {
                cache: cachedDeviceList
            });
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Error while updating cached device info (udpate): ${ex.message}`);
        }
    }

    private async deleteCachedDeviceInfo(cameraId: string): Promise<void> {
        try {
            const { cachedDeviceList, cachedDeviceIndex } = await this.getCachedDeviceList(cameraId);
            if (cachedDeviceIndex > -1) {
                cachedDeviceList.splice(cachedDeviceIndex, 1);
            }

            await this.server.settings.app.config.set(DeviceCache, {
                cache: cachedDeviceList
            });
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Error while updating cached device info (delete): ${ex.message}`);
        }
    }

    private async getCachedDeviceList(cameraId: string): Promise<{ cachedDeviceList: IDeviceCacheInfo[]; cachedDeviceIndex: number }> {
        try {
            const deviceCache = await this.server.settings.app.config.get(DeviceCache);
            const cachedDeviceList: IDeviceCacheInfo[] = deviceCache.cache || [];

            const cachedDeviceIndex = cachedDeviceList.findIndex((element) => element.cameraInfo.cameraId === cameraId);
            if (cachedDeviceIndex > -1) {
                cachedDeviceList.splice(cachedDeviceIndex, 1);
            }

            return {
                cachedDeviceList,
                cachedDeviceIndex
            };
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Error while retrieving cached device list: ${ex.message}`);
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

        const directMethodResponse: any = {
            [CommandResponseParams.StatusCode]: 200,
            [CommandResponseParams.Message]: ''
        };

        try {
            switch (commandRequest.methodName) {
                case AvaGatewayCapability.cmConfigureGateway: {
                    const configureGatewayResult = await this.configureGateway(commandRequest?.payload);
                    if (configureGatewayResult.result) {
                        directMethodResponse[CommandResponseParams.StatusCode] = 200;
                        directMethodResponse[CommandResponseParams.Message] = `Gateway configuration completed successfully`;
                        directMethodResponse[CommandResponseParams.Data] = configureGatewayResult.payload;
                    }
                    else {
                        directMethodResponse[CommandResponseParams.StatusCode] = 500;
                        directMethodResponse[CommandResponseParams.Message] = `An error occurred during the configure gateway operation`;
                    }

                    break;
                }

                case AvaGatewayCapability.cmDiscoverOnvifCameras: {
                    const discoverCamerasResult = await this.discoverCameras(commandRequest?.payload?.[DiscoverCamerasCommandRequestParams.Timeout] || 0);
                    if (discoverCamerasResult.result) {
                        directMethodResponse[CommandResponseParams.StatusCode] = 200;
                        directMethodResponse[CommandResponseParams.Message] = `Camera discovery completed successfully`;
                        directMethodResponse[CommandResponseParams.Data] = discoverCamerasResult.payload;
                    }
                    else {
                        directMethodResponse[CommandResponseParams.StatusCode] = 500;
                        directMethodResponse[CommandResponseParams.Message] = `An error occurred during the discover cameras operation`;
                    }

                    break;
                }

                case AvaGatewayCapability.cmGetCameraDevices: {
                    const getCamerasResult = await this.getCameras();
                    if (getCamerasResult.result) {
                        directMethodResponse[CommandResponseParams.StatusCode] = 200;
                        directMethodResponse[CommandResponseParams.Message] = `Getting camera list succeeded`;
                        directMethodResponse[CommandResponseParams.Data] = getCamerasResult.payload;
                    }
                    else {
                        directMethodResponse[CommandResponseParams.StatusCode] = 500;
                        directMethodResponse[CommandResponseParams.Message] = `An error occurred while getting the camera list`;
                    }

                    break;
                }

                case AvaGatewayCapability.cmAddCameraDevice: {
                    const cameraInfo: ICameraProvisionInfo = {
                        cameraId: commandRequest?.payload?.[AddCameraCommandRequestParams.CameraId],
                        cameraName: commandRequest?.payload?.[AddCameraCommandRequestParams.CameraName],
                        ipAddress: commandRequest?.payload?.[AddCameraCommandRequestParams.IpAddress],
                        onvifUsername: commandRequest?.payload?.[AddCameraCommandRequestParams.OnvifUsername],
                        onvifPassword: commandRequest?.payload?.[AddCameraCommandRequestParams.OnvifPassword]
                    };

                    if (!cameraInfo.cameraId
                        || !cameraInfo.cameraName
                        || !cameraInfo.ipAddress
                        || !cameraInfo.onvifUsername
                        || !cameraInfo.onvifPassword) {
                        directMethodResponse[CommandResponseParams.StatusCode] = 400;
                        directMethodResponse[CommandResponseParams.Message] = `Missing required parameters`;
                    }
                    else {
                        const provisionResult = await this.createAvaInferenceDevice(cameraInfo);

                        directMethodResponse[CommandResponseParams.StatusCode] = 200;
                        directMethodResponse[CommandResponseParams.Message] = provisionResult.clientConnectionMessage || provisionResult.dpsProvisionMessage;
                    }

                    break;
                }

                case AvaGatewayCapability.cmDeleteCameraDevice: {
                    const cameraId = commandRequest?.payload?.[DeleteCameraCommandRequestParams.CameraId];
                    if (!cameraId) {
                        directMethodResponse[CommandResponseParams.StatusCode] = 400;
                        directMethodResponse[CommandResponseParams.Message] = `Missing required Camera Id parameter`;
                    }
                    else {
                        const deleteResult = await this.deprovisionAvaInferenceDevice(cameraId);
                        if (deleteResult) {
                            directMethodResponse[CommandResponseParams.StatusCode] = 200;
                            directMethodResponse[CommandResponseParams.Message] = `Finished deprovisioning camera device ${cameraId}`;
                        }
                        else {
                            directMethodResponse[CommandResponseParams.StatusCode] = 500;
                            directMethodResponse[CommandResponseParams.Message] = `Error deprovisioning camera device ${cameraId}`;
                        }
                    }

                    break;
                }

                case AvaGatewayCapability.cmRestartGatewayModule:
                    await this.restartModule(commandRequest?.payload?.[RestartGatewayModuleCommandRequestParams.Timeout] || 0, 'RestartModule command received');

                    directMethodResponse[CommandResponseParams.StatusCode] = 200;
                    directMethodResponse[directMethodResponse.Message] = 'Restart module request received';
                    break;

                case AvaGatewayCapability.cmClearDeviceCache:
                    await this.server.settings.app.config.set(DeviceCache, {});

                    directMethodResponse[CommandResponseParams.StatusCode] = 200;
                    directMethodResponse[CommandResponseParams.Message] = `The device cache was cleared`;
                    break;

                case AvaGatewayCapability.cmClearPipelineCache: {
                    const clearResult = await this.server.settings.app.config.clear(PipelineCache);
                    if (clearResult) {
                        directMethodResponse[CommandResponseParams.StatusCode] = 200;
                        directMethodResponse[CommandResponseParams.Message] = `The pipeline cache was cleared`;
                    }
                    else {
                        directMethodResponse[CommandResponseParams.StatusCode] = 500;
                        directMethodResponse[CommandResponseParams.Message] = `An error occured while attempting to clear the pipeline cache`;
                    }

                    break;
                }

                default:
                    directMethodResponse[CommandResponseParams.StatusCode] = 400;
                    directMethodResponse[CommandResponseParams.Message] = `An unknown method name was found: ${commandRequest.methodName}`;
            }

            this.server.log([ModuleName, 'info'], directMethodResponse[CommandResponseParams.Message]);
        }
        catch (ex) {
            directMethodResponse[CommandResponseParams.StatusCode] = 500;
            directMethodResponse[CommandResponseParams.Message] = `An error occurred executing the command ${commandRequest.methodName}: ${ex.message}`;

            this.server.log([ModuleName, 'error'], directMethodResponse[CommandResponseParams.Message]);
        }

        await commandResponse.send(200, directMethodResponse);
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
