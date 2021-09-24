import { Server } from '@hapi/hapi';
import { IIotCentralModule } from '../plugins/iotCentralModule';
import { AvaPipeline } from './avaPipeline';
import {
    PipelineCache,
    ICameraProvisionInfo
} from './cameraGateway';
import { HealthState } from './health';
import { Mqtt as IoTHubTransport } from 'azure-iot-device-mqtt';
import {
    DeviceMethodRequest,
    DeviceMethodResponse,
    Client as IoTDeviceClient,
    Twin,
    Message as IoTMessage
} from 'azure-iot-device';
import { join as pathJoin } from 'path';
import * as moment from 'moment';
import { bind, defer, emptyObj } from '../utils';

export type DirectMethodHandler = (...args: any[]) => Promise<{ result: boolean; payload: any }>;

export interface IClientConnectResult {
    clientConnectionStatus: boolean;
    clientConnectionMessage: string;
}

enum CameraProcessingState {
    Inactive = 'inactive',
    Active = 'active'
}

interface IOnvifCameraInformation {
    manufacturer: string;
    model: string;
    firmwareVersion: string;
    hardwareId: string;
    serialNumber: string;
}

export interface IOnlineCameraInformation extends IOnvifCameraInformation {
    name: string;
    id: string;
    ipAddress: string;
    processingState: CameraProcessingState;
    avaPipelineTopologyName: string;
    avaLivePipelineName: string;
}

enum IoTCentralClientState {
    Disconnected = 'disconnected',
    Connected = 'connected'
}

export enum CameraCapability {
    tlSystemHeartbeat = 'tlSystemHeartbeat',
    stIoTCentralClientState = 'stIoTCentralClientState',
    stCameraProcessingState = 'stCameraProcessingState',
    rpCameraName = 'rpCameraName',
    rpIpAddress = 'rpIpAddress',
    rpUsername = 'rpUsername',
    rpPassword = 'rpPassword',
    cmStartAvaPipeline = 'cmStartAvaPipeline',
    cmStopAvaPipeline = 'cmStopAvaPipeline',
    cmGetAvaProcessingStatus = 'cmGetAvaProcessingStatus',
    wpVideoPlaybackHost = 'wpVideoPlaybackHost'
}

export enum OnvifCameraCapability {
    evUploadImage = 'evUploadImage',
    rpCaptureImageUrl = 'rpCaptureImageUrl',
    cmGetOnvifCameraProps = 'cmGetOnvifCameraProps',
    cmGetOnvifMediaProfiles = 'cmGetOnvifMediaProfiles',
    cmGetOnvifRtspStreamUrl = 'cmGetOnvifRtspStreamUrl',
    cmCaptureOnvifImage = 'cmCaptureOnvifImage',
    cmRestartOnvifCamera = 'cmRestartOnvifCamera',
}

interface IOnvifCameraSettings {
    [CameraCapability.wpVideoPlaybackHost]: string;
}

const defaultVideoPlaybackHost = 'http://localhost:8094';
const defaultInferenceTimeout = 5;
const defaultMaxVideoInferenceTime = 10;

interface IGetOnvifRtspStreamUrlCommandRequestParams {
    mediaProfileToken: string;
}

interface ICaptureOnvifImageCommandRequestParams {
    mediaProfileToken: string;
}

interface IStartAvaPipelineCommandRequestParams {
    avaPipelineTopologyName: string;
    avaLivePipelineName: string;
    mediaProfileToken: string;
}

interface DeviceCommandResponse {
    statusCode: number;
    message: string;
    payload?: any;
}

enum AvaEdgeOperationsCapability {
    evPipelineInstanceCreated = 'evPipelineInstanceCreated',
    evPipelineInstanceDeleted = 'evPipelineInstanceDeleted',
    evPipelineInstanceStarted = 'evPipelineInstanceStarted',
    evPipelineInstanceStopped = 'evPipelineInstanceStopped',
    evRecordingStarted = 'evRecordingStarted',
    evRecordingStopped = 'evRecordingStopped',
    evRecordingAvailable = 'evRecordingAvailable',
    wpMaxVideoInferenceTime = 'wpMaxVideoInferenceTime'
}

interface IAvaEdgeOperationsSettings {
    [AvaEdgeOperationsCapability.wpMaxVideoInferenceTime]: number;
}

enum AvaEdgeDiagnosticsCapability {
    evRuntimeError = 'evRuntimeError',
    evAuthenticationError = 'evAuthenticationError',
    evAuthorizationError = 'evAuthorizationError',
    evDataDropped = 'evDataDropped',
    evMediaFormatError = 'evMediaFormatError',
    evMediaSessionEstablished = 'evMediaSessionEstablished',
    evNetworkError = 'evNetworkError',
    evProtocolError = 'evProtocolError',
    evStorageError = 'evStorageError',
    wpDebugTelemetry = 'wpDebugTelemetry'
}

interface IAvaEdgeDiagnosticsSettings {
    [AvaEdgeDiagnosticsCapability.wpDebugTelemetry]: boolean;
}

export enum AiInferenceCapability {
    tlInferenceEntity = 'tlInferenceEntity',
    evInferenceEventVideoUrl = 'evInferenceEventVideoUrl',
    wpInferenceTimeout = 'wpInferenceTimeout'
}

enum UnmodeledTelemetry {
    tlFullInferenceEntity = 'tlFullInferenceEntity',
}

enum EntityType {
    Entity = 'entity',
    Event = 'event'
}
interface IAvaInference {
    type: string;
    [key: string]: any;
}

interface IAiInferenceSettings {
    [AiInferenceCapability.wpInferenceTimeout]: number;
}

export class AvaCameraDevice {
    protected server: Server;
    protected iotCentralModule: IIotCentralModule;
    protected onvifModuleId: string;
    protected avaEdgeModuleId: string;
    protected appScopeId: string;
    protected avaPipeline: AvaPipeline;
    protected cameraInfo: ICameraProvisionInfo;
    protected onvifCameraInformationInternal: IOnvifCameraInformation;
    protected avaProcessingState: CameraProcessingState;
    protected deviceClient: IoTDeviceClient;
    protected deviceTwin: Twin;

    protected deferredStart = defer();
    protected healthState = HealthState.Good;
    protected lastInferenceTime: moment.Moment = moment.utc(0);
    protected videoInferenceStartTime: moment.Moment = moment.utc();
    protected onvifCameraSettings: IOnvifCameraSettings = {
        wpVideoPlaybackHost: defaultVideoPlaybackHost
    };
    protected avaEdgeOperationsSettings: IAvaEdgeOperationsSettings = {
        [AvaEdgeOperationsCapability.wpMaxVideoInferenceTime]: defaultMaxVideoInferenceTime
    };
    protected avaEdgeDiagnosticsSettings: IAvaEdgeDiagnosticsSettings = {
        [AvaEdgeDiagnosticsCapability.wpDebugTelemetry]: false
    };
    protected aiInferenceSettings: IAiInferenceSettings = {
        [AiInferenceCapability.wpInferenceTimeout]: defaultInferenceTimeout
    };
    private inferenceInterval: NodeJS.Timeout;
    private createVideoLinkForInferenceTimeout = false;

    constructor(
        server: Server,
        onvifModuleId: string,
        avaEdgeModuleId: string,
        appScopeId: string,
        cameraInfo: ICameraProvisionInfo
    ) {
        this.server = server;
        this.iotCentralModule = server.settings.app.iotCentralModule;
        this.onvifModuleId = onvifModuleId;
        this.avaEdgeModuleId = avaEdgeModuleId;
        this.appScopeId = appScopeId;
        this.cameraInfo = cameraInfo;
    }

    public get cameraProvisionInfo(): ICameraProvisionInfo {
        return this.cameraInfo;
    }

    public get onvifCameraInformation(): IOnvifCameraInformation {
        return this.onvifCameraInformationInternal;
    }

    public get processingState(): CameraProcessingState {
        return this.avaProcessingState;
    }

    public get avaPipelineTopologyName(): string {
        return this.avaPipeline?.pipelineTopologyName || '';
    }

    public get avaLivePipelineName(): string {
        return this.avaPipeline?.livePipelineName || '';
    }

    public async connectDeviceClient(
        dpsHubConnectionString: string,
        avaPipelineTopologyName?: string,
        avaLivePipelineName?: string,
        onvifMediaProfileToken?: string
    ): Promise<IClientConnectResult> {
        let clientConnectionResult: IClientConnectResult = {
            clientConnectionStatus: false,
            clientConnectionMessage: ''
        };

        try {
            clientConnectionResult = await this.connectDeviceClientInternal(dpsHubConnectionString);

            if (clientConnectionResult.clientConnectionStatus) {
                await this.deferredStart.promise;

                await this.deviceReady();

                if (avaPipelineTopologyName && avaLivePipelineName && onvifMediaProfileToken) {
                    const startAvaPipelineResult = await this.startAvaProcessing(avaPipelineTopologyName, avaLivePipelineName, onvifMediaProfileToken);

                    this.avaProcessingState = startAvaPipelineResult ? CameraProcessingState.Inactive : CameraProcessingState.Active;
                }
                else {
                    this.avaProcessingState = CameraProcessingState.Inactive;
                }

                await this.sendMeasurement({
                    [CameraCapability.stIoTCentralClientState]: IoTCentralClientState.Connected,
                    [CameraCapability.stCameraProcessingState]: this.avaProcessingState
                });
            }
        }
        catch (ex) {
            clientConnectionResult.clientConnectionStatus = false;
            clientConnectionResult.clientConnectionMessage = `An error occurred while accessing the device twin properties`;

            this.server.log([this.cameraInfo.cameraId, 'error'], clientConnectionResult.clientConnectionMessage);
        }

        return clientConnectionResult;
    }

    @bind
    public async getHealth(): Promise<number> {
        await this.sendMeasurement({
            [CameraCapability.tlSystemHeartbeat]: this.healthState
        });

        return this.healthState;
    }

    public async deleteCamera(): Promise<void> {
        this.server.log([this.cameraInfo.cameraId, 'info'], `Deleting camera device instance for cameraId: ${this.cameraInfo.cameraId}`);

        try {
            if (this.avaPipeline) {
                this.server.log([this.cameraInfo.cameraId, 'info'], `Deactivating pipeline instance: ${this.avaPipeline.livePipelineName}`);
                await this.avaPipeline.deleteAvaPipeline();
            }

            if (this.deviceTwin) {
                this.deviceTwin.removeAllListeners();
            }

            if (this.deviceClient) {
                this.deviceClient.removeAllListeners();

                await this.deviceClient.close();
            }

            this.deviceClient = null;
            this.deviceTwin = null;

            this.avaProcessingState = CameraProcessingState.Inactive;
            await this.sendMeasurement({
                [CameraCapability.stCameraProcessingState]: this.avaProcessingState
            });
        }
        catch (ex) {
            this.server.log([this.cameraInfo.cameraId, 'error'], `Error while deleting camera: ${this.cameraInfo.cameraId}`);
        }
    }

    public async sendAvaEvent(avaEvent: string, messageJson?: any): Promise<void> {
        let eventField;
        let eventValue = this.cameraInfo.cameraId;

        switch (avaEvent) {
            case 'Microsoft.VideoAnalyzer.Operational.RecordingStarted':
                eventField = AvaEdgeOperationsCapability.evRecordingStarted;
                eventValue = messageJson?.outputLocation || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.VideoAnalyzer.Operational.RecordingStopped':
                eventField = AvaEdgeOperationsCapability.evRecordingStopped;
                eventValue = messageJson?.outputLocation || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.VideoAnalyzer.Operational.RecordingAvailable':
                eventField = AvaEdgeOperationsCapability.evRecordingAvailable;
                eventValue = messageJson?.outputLocation || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.VideoAnalyzer.Diagnostics.RuntimeError':
                eventField = AvaEdgeDiagnosticsCapability.evRuntimeError;
                eventValue = messageJson?.code || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.VideoAnalyzer.Diagnostics.AuthenticationError':
                eventField = AvaEdgeDiagnosticsCapability.evAuthenticationError;
                eventValue = messageJson?.errorCode || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.VideoAnalyzer.Diagnostics.AuthorizationError':
                eventField = AvaEdgeDiagnosticsCapability.evAuthorizationError;
                eventValue = messageJson?.errorCode || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.VideoAnalyzer.Diagnostics.DataDropped':
                eventField = AvaEdgeDiagnosticsCapability.evDataDropped;
                eventValue = messageJson?.dataType || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.VideoAnalyzer.Diagnostics.MediaFormatError':
                eventField = AvaEdgeDiagnosticsCapability.evMediaFormatError;
                eventValue = messageJson?.code || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.VideoAnalyzer.Diagnostics.MediaSessionEstablished':
                eventField = AvaEdgeDiagnosticsCapability.evMediaSessionEstablished;
                eventValue = this.cameraInfo.cameraId;
                break;

            case 'Microsoft.VideoAnalyzer.Diagnostics.NetworkError':
                eventField = AvaEdgeDiagnosticsCapability.evNetworkError;
                eventValue = messageJson?.errorCode || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.VideoAnalyzer.Diagnostics.ProtocolError':
                eventField = AvaEdgeDiagnosticsCapability.evProtocolError;
                eventValue = `${messageJson?.protocol}: ${messageJson?.errorCode}` || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.VideoAnalyzer.Diagnostics.StorageError':
                eventField = AvaEdgeDiagnosticsCapability.evStorageError;
                eventValue = messageJson?.storageAccountName || this.cameraInfo.cameraId;
                break;

            default:
                this.server.log([this.cameraInfo.cameraId, 'warning'], `Received Unknown AVA event telemetry: ${avaEvent}`);
                break;
        }

        if (avaEvent) {
            await this.sendMeasurement({
                [eventField]: eventValue
            });
        }
        else {
            this.server.log([this.cameraInfo.cameraId, 'warning'], `Received Unknown AVA event telemetry: ${avaEvent}`);
        }
    }

    public async processAvaInferences(inferences: IAvaInference[]): Promise<void> {
        if (!Array.isArray(inferences) || !this.deviceClient) {
            this.server.log([this.cameraInfo.cameraId, 'error'], `Missing inferences array or client not connected`);
            return;
        }

        this.server.log([this.cameraInfo.cameraId, 'info'], `processAvaInferences: received ${inferences.length} inferences`);

        this.lastInferenceTime = moment.utc();

        try {
            for (const inference of inferences) {
                let inferenceEntity;

                if (inference.type === EntityType.Entity) {
                    inferenceEntity = {
                        [AiInferenceCapability.tlInferenceEntity]: {
                            value: inference.entity?.tag?.value,
                            confidence: inference.entity?.tag?.confidence
                        }
                    };
                }

                await this.sendMeasurement({
                    [UnmodeledTelemetry.tlFullInferenceEntity]: inference,
                    ...inferenceEntity
                });
            }
        }
        catch (ex) {
            this.server.log([this.cameraInfo.cameraId, 'error'], `Error processing downstream message: ${ex.message}`);
        }
    }

    private debugTelemetry(): boolean {
        return this.avaEdgeDiagnosticsSettings[AvaEdgeDiagnosticsCapability.wpDebugTelemetry];
    }

    private async deviceReady(): Promise<void> {
        this.server.log([this.cameraInfo.cameraId, 'info'], `Device is ready`);

        await this.getOnvifCameraProps();

        await this.updateDeviceProperties({
            [CameraCapability.rpCameraName]: this.cameraInfo.cameraName,
            [CameraCapability.rpIpAddress]: this.cameraInfo.ipAddress,
            [CameraCapability.rpUsername]: this.cameraInfo.onvifUsername,
            [CameraCapability.rpPassword]: this.cameraInfo.onvifPassword,
            [OnvifCameraCapability.rpCaptureImageUrl]: ''
        });
    }

    private async getOnvifCameraProps(): Promise<DeviceCommandResponse> {
        const response: DeviceCommandResponse = {
            statusCode: 200,
            message: `Retrieved onvif camera properties successfully`
        };

        try {
            const deviceInfoResult = await this.iotCentralModule.invokeDirectMethod(
                this.onvifModuleId,
                'GetDeviceInformation',
                {
                    Address: this.cameraInfo.ipAddress,
                    Username: this.cameraInfo.onvifUsername,
                    Password: this.cameraInfo.onvifPassword
                });

            response.payload = {
                manufacturer: deviceInfoResult.payload?.Manufacturer || '',
                model: deviceInfoResult.payload?.Model || '',
                firmwareVersion: deviceInfoResult.payload?.Firmware || '',
                hardwareId: deviceInfoResult.payload?.HardwareId || '',
                serialNumber: deviceInfoResult.payload?.SerialNumber || ''
            };

            this.onvifCameraInformationInternal = response.payload;

            await this.updateDeviceProperties({
                rpManufacturer: response.payload.manufacturer,
                rpModel: response.payload.model,
                rpFirmwareVersion: response.payload.firmwareVersion,
                rpHardwareId: response.payload.hardwareId,
                rpSerialNumber: response.payload.serialNumber
            });
        }
        catch (ex) {
            response.statusCode = 500;
            response.message = `Error getting onvif device properties: ${ex.message}`;

            this.server.log([this.cameraInfo.cameraId, 'error'], response.message);
        }

        return response;
    }

    private async getOnvifMediaProfiles(): Promise<DeviceCommandResponse> {
        const response: DeviceCommandResponse = {
            statusCode: 200,
            message: `Retrieved onvif media profiles successfully`,
            payload: []
        };

        try {
            const mediaProfileResult = await this.iotCentralModule.invokeDirectMethod(
                this.onvifModuleId,
                'GetMediaProfileList',
                {
                    Address: this.cameraInfo.ipAddress,
                    Username: this.cameraInfo.onvifUsername,
                    Password: this.cameraInfo.onvifPassword
                });

            response.payload = (mediaProfileResult.payload || []).map((item) => {
                return {
                    mediaProfileName: item.MediaProfileName,
                    mediaProfileToken: item.MediaProfileToken
                };
            });
        }
        catch (ex) {
            response.statusCode = 500;
            response.message = `Error getting onvif device media profiles: ${ex.message}`;

            this.server.log([this.cameraInfo.cameraId, 'error'], response.message);
        }

        return response;
    }

    private async getOnvifRtspStreamUrl(mediaProfileToken: string): Promise<DeviceCommandResponse> {
        const response: DeviceCommandResponse = {
            statusCode: 200,
            message: `Retrieved onvif rtsp stream url successfully`
        };

        try {
            const requestParams = {
                Address: this.cameraInfo.ipAddress,
                Username: this.cameraInfo.onvifUsername,
                Password: this.cameraInfo.onvifPassword,
                MediaProfileToken: mediaProfileToken
            };

            const serviceResponse = await this.iotCentralModule.invokeDirectMethod(
                this.onvifModuleId,
                'GetRTSPStreamURI',
                requestParams);

            response.payload = serviceResponse.status === 200 ? serviceResponse.payload : '';
        }
        catch (ex) {
            response.statusCode = 500;
            response.message = `An error occurred while getting onvif stream uri from device id: ${this.cameraInfo.cameraId}`;
            this.server.log([this.cameraInfo.cameraId, 'error'], response.message);
        }

        return response;
    }

    @bind
    private async onHandleDeviceProperties(desiredChangedSettings: any): Promise<void> {
        try {
            this.server.log([this.cameraInfo.cameraId, 'info'], `onHandleDeviceProperties`);
            if (this.debugTelemetry()) {
                this.server.log([this.cameraInfo.cameraId, 'info'], JSON.stringify(desiredChangedSettings, null, 4));
            }

            const patchedProperties = {};

            for (const setting in desiredChangedSettings) {
                if (!Object.prototype.hasOwnProperty.call(desiredChangedSettings, setting)) {
                    continue;
                }

                if (setting === '$version') {
                    continue;
                }

                const value = Object.prototype.hasOwnProperty.call(desiredChangedSettings[setting], 'value')
                    ? desiredChangedSettings[setting].value
                    : desiredChangedSettings[setting];

                switch (setting) {
                    case CameraCapability.wpVideoPlaybackHost:
                        patchedProperties[setting] = {
                            value: (this.onvifCameraSettings[setting] as any) = value || defaultVideoPlaybackHost,
                            ac: 200,
                            ad: 'completed',
                            av: desiredChangedSettings['$version']
                        };
                        break;

                    case AvaEdgeOperationsCapability.wpMaxVideoInferenceTime:
                        patchedProperties[setting] = {
                            value: (this.avaEdgeOperationsSettings[setting] as any) = value || defaultMaxVideoInferenceTime,
                            ac: 200,
                            ad: 'completed',
                            av: desiredChangedSettings['$version']
                        };
                        break;

                    case AvaEdgeDiagnosticsCapability.wpDebugTelemetry:
                        patchedProperties[setting] = {
                            value: (this.avaEdgeDiagnosticsSettings[setting] as any) = value || false,
                            ac: 200,
                            ad: 'completed',
                            av: desiredChangedSettings['$version']
                        };
                        break;

                    case AiInferenceCapability.wpInferenceTimeout:
                        patchedProperties[setting] = {
                            value: (this.aiInferenceSettings[setting] as any) = value || defaultInferenceTimeout,
                            ac: 200,
                            ad: 'completed',
                            av: desiredChangedSettings['$version']
                        };
                        break;

                    default:
                        break;
                }
            }

            if (!emptyObj(patchedProperties)) {
                await this.updateDeviceProperties(patchedProperties);
            }
        }
        catch (ex) {
            this.server.log([this.cameraInfo.cameraId, 'error'], `Exception while handling desired properties: ${ex.message}`);
        }

        this.deferredStart.resolve();
    }

    private async updateDeviceProperties(properties: any): Promise<void> {
        if (!properties || !this.deviceTwin) {
            return;
        }

        try {
            await new Promise((resolve, reject) => {
                this.deviceTwin.properties.reported.update(properties, (error) => {
                    if (error) {
                        return reject(error);
                    }

                    return resolve('');
                });
            });

            if (this.debugTelemetry()) {
                this.server.log([this.cameraInfo.cameraId, 'info'], `Device live properties updated: ${JSON.stringify(properties, null, 4)}`);
            }
        }
        catch (ex) {
            this.server.log([this.cameraInfo.cameraId, 'error'], `Error while updating client properties: ${ex.message}`);
        }
    }

    private async sendMeasurement(data: any): Promise<void> {
        if (!data || !this.deviceClient) {
            return;
        }

        try {
            const iotcMessage = new IoTMessage(JSON.stringify(data));

            await this.deviceClient.sendEvent(iotcMessage);

            if (this.debugTelemetry()) {
                this.server.log([this.cameraInfo.cameraId, 'info'], `sendEvent: ${JSON.stringify(data, null, 4)}`);
            }
        }
        catch (ex) {
            this.server.log([this.cameraInfo.cameraId, 'error'], `sendMeasurement: ${ex.message}`);
            this.server.log([this.cameraInfo.cameraId, 'error'], `inspect the error: ${JSON.stringify(ex, null, 4)}`);
        }
    }

    private async inferenceTimer(): Promise<void> {
        try {
            if (this.debugTelemetry()) {
                this.server.log([this.cameraInfo.cameraId, 'info'], `Inference timer`);
            }

            const videoInferenceDuration = moment.duration(moment.utc().diff(this.videoInferenceStartTime));

            if (moment.duration(moment.utc().diff(this.lastInferenceTime)) >= moment.duration(this.aiInferenceSettings[AiInferenceCapability.wpInferenceTimeout], 'seconds')) {
                if (this.createVideoLinkForInferenceTimeout) {
                    this.createVideoLinkForInferenceTimeout = false;

                    this.server.log([this.cameraInfo.cameraId, 'info'], `InferenceTimeout reached`);

                    await this.sendMeasurement({
                        [AiInferenceCapability.evInferenceEventVideoUrl]: this.avaPipeline.createInferenceVideoLink(
                            this.onvifCameraSettings[CameraCapability.wpVideoPlaybackHost],
                            this.videoInferenceStartTime,
                            Math.trunc(videoInferenceDuration.asSeconds()))
                    });
                }

                this.videoInferenceStartTime = moment.utc();
            }
            else {
                this.createVideoLinkForInferenceTimeout = true;

                if (videoInferenceDuration >= moment.duration(this.avaEdgeOperationsSettings[AvaEdgeOperationsCapability.wpMaxVideoInferenceTime], 'seconds')) {
                    this.server.log([this.cameraInfo.cameraId, 'info'], `MaxVideoInferenceTime reached`);

                    await this.sendMeasurement({
                        [AiInferenceCapability.evInferenceEventVideoUrl]: this.avaPipeline.createInferenceVideoLink(
                            this.onvifCameraSettings[CameraCapability.wpVideoPlaybackHost],
                            this.videoInferenceStartTime,
                            Math.trunc(videoInferenceDuration.asSeconds()))
                    });

                    this.videoInferenceStartTime = moment.utc();
                }
            }
        }
        catch (ex) {
            this.server.log([this.cameraInfo.cameraId, 'error'], `Inference timer error: ${ex.message}`);
        }
    }

    private async connectDeviceClientInternal(dpsHubConnectionString: string): Promise<IClientConnectResult> {

        const result: IClientConnectResult = {
            clientConnectionStatus: false,
            clientConnectionMessage: ''
        };

        if (this.deviceClient) {
            if (this.deviceTwin) {
                this.deviceTwin.removeAllListeners();
            }

            if (this.deviceClient) {
                this.deviceTwin.removeAllListeners();

                await this.deviceClient.close();
            }

            this.deviceClient = null;
            this.deviceTwin = null;
        }

        try {
            this.deviceClient = await IoTDeviceClient.fromConnectionString(dpsHubConnectionString, IoTHubTransport);
            if (!this.deviceClient) {
                result.clientConnectionStatus = false;
                result.clientConnectionMessage = `Failed to connect device client interface from connection string - device: ${this.cameraInfo.cameraId}`;
            }
            else {
                result.clientConnectionStatus = true;
                result.clientConnectionMessage = `Successfully connected to IoT Central - device: ${this.cameraInfo.cameraId}`;
            }
        }
        catch (ex) {
            result.clientConnectionStatus = false;
            result.clientConnectionMessage = `Failed to instantiate client interface from configuraiton: ${ex.message}`;

            this.server.log([this.cameraInfo.cameraId, 'error'], `${result.clientConnectionMessage}`);
        }

        if (result.clientConnectionStatus === false) {
            return result;
        }

        try {
            this.deviceClient.on('connect', this.onDeviceClientConnect);
            this.deviceClient.on('disconnect', this.onDeviceClientDisconnect);
            this.deviceClient.on('error', this.onDeviceClientError);

            await this.deviceClient.open();

            this.server.log([this.cameraInfo.cameraId, 'info'], `Device client is connected`);

            this.deviceTwin = await this.deviceClient.getTwin();
            this.deviceTwin.on('properties.desired', this.onHandleDeviceProperties);

            this.deviceClient.onDeviceMethod(OnvifCameraCapability.cmGetOnvifCameraProps, this.handleDirectMethod);
            this.deviceClient.onDeviceMethod(OnvifCameraCapability.cmGetOnvifMediaProfiles, this.handleDirectMethod);
            this.deviceClient.onDeviceMethod(OnvifCameraCapability.cmGetOnvifRtspStreamUrl, this.handleDirectMethod);
            this.deviceClient.onDeviceMethod(OnvifCameraCapability.cmCaptureOnvifImage, this.handleDirectMethod);
            this.deviceClient.onDeviceMethod(CameraCapability.cmStartAvaPipeline, this.handleDirectMethod);
            this.deviceClient.onDeviceMethod(CameraCapability.cmStopAvaPipeline, this.handleDirectMethod);
            this.deviceClient.onDeviceMethod(CameraCapability.cmGetAvaProcessingStatus, this.handleDirectMethod);
            this.deviceClient.onDeviceMethod(OnvifCameraCapability.cmRestartOnvifCamera, this.handleDirectMethod);

            result.clientConnectionStatus = true;
        }
        catch (ex) {
            result.clientConnectionStatus = false;
            result.clientConnectionMessage = `IoT Central connection error: ${ex.message}`;

            this.server.log([this.cameraInfo.cameraId, 'error'], result.clientConnectionMessage);
        }

        return result;
    }

    @bind
    private onDeviceClientConnect() {
        this.server.log([this.cameraInfo.cameraId, 'info'], `The device received a connect event`);
    }

    @bind
    private onDeviceClientDisconnect() {
        this.server.log([this.cameraInfo.cameraId, 'info'], `The device received a disconnect event`);
    }

    @bind
    private onDeviceClientError(error: Error) {
        this.deviceClient = null;
        this.deviceTwin = null;

        this.server.log([this.cameraInfo.cameraId, 'error'], `Device client connection error: ${error.message}`);
        this.healthState = HealthState.Critical;
    }

    private async captureImage(mediaProfileToken: string): Promise<DeviceCommandResponse> {
        this.server.log([this.cameraInfo.cameraId, 'info'], `captureImage`);

        const response: DeviceCommandResponse = {
            statusCode: 200,
            message: `Image capture completed successfully`
        };

        try {
            const requestParams = {
                Address: this.cameraInfo.ipAddress,
                Username: this.cameraInfo.onvifUsername,
                Password: this.cameraInfo.onvifPassword,
                MediaProfileToken: mediaProfileToken
            };

            this.server.log([this.cameraInfo.cameraId, 'info'], `Starting onvif image capture...`);

            const captureImageResult = await this.server.settings.app.iotCentralModule.invokeDirectMethod(
                this.onvifModuleId,
                'GetSnapshot',
                requestParams);

            if (captureImageResult.status >= 200 && captureImageResult.status < 300) {
                this.server.log([this.cameraInfo.cameraId, 'info'], `Image capture complete, uploading image data to blob storage...`);

                const blobName = `${this.appScopeId}-${this.iotCentralModule.deviceId}-${this.cameraInfo.cameraId}-${moment.utc().format('YYYYMMDD-HHmmss')}`;
                response.payload = await this.server.settings.app.blobStorage.uploadBase64ImageToBlobStorageContainer(captureImageResult.payload as string, blobName);

                response.statusCode = 200;
                response.message = `Image capture completed successfully`;

                this.server.log([this.cameraInfo.cameraId, 'info'], response.message);
            }

            if (response.payload) {
                await this.sendMeasurement({
                    [OnvifCameraCapability.evUploadImage]: response.payload
                });

                await this.updateDeviceProperties({
                    [OnvifCameraCapability.rpCaptureImageUrl]: response.payload
                });
            }
            else {
                response.statusCode = 500;
                response.message = `An error occurred while uploading the captured image to the blob storage service`;

                this.server.log([this.cameraInfo.cameraId, 'error'], response.message);
            }
        }
        catch (ex) {
            response.statusCode = 500;
            response.message = `An error occurred while attempting to capture an image on device: ${this.cameraInfo.cameraId}: ${ex.message}`;

            this.server.log([this.cameraInfo.cameraId, 'error'], response.message);
        }

        return response;
    }

    private async getPipelineContent(contentName: string): Promise<any> {
        let avaPipelineContent = this.server.settings.app.config.get(pathJoin(PipelineCache, contentName));

        if (!avaPipelineContent || emptyObj(avaPipelineContent)) {
            this.server.log([this.cameraInfo.cameraId, 'info'], `Pipeline content named: ${contentName} not found in cache. Downloading from blob store...`);
            avaPipelineContent = await this.server.settings.app.blobStorage.getFileFromBlobStorage(`${contentName}.json`);

            if (!avaPipelineContent) {
                this.server.log([this.cameraInfo.cameraId, 'error'], `Could not retrieve pipeline content named: ${contentName}`);
                return;
            }

            await this.server.settings.app.config.set(pathJoin(PipelineCache, contentName), avaPipelineContent);
        }

        this.server.log([this.cameraInfo.cameraId, 'info'], `Successfully retrieved pipeline content named: ${contentName}`);

        return avaPipelineContent;
    }

    private async initializeAvaProcessor(avaPipelineTopologyName: string, avaLivePipelineName: string, mediaProfileToken: string): Promise<boolean> {
        const getRtspStreamUrlResponse = await this.getOnvifRtspStreamUrl(mediaProfileToken);
        if (getRtspStreamUrlResponse.statusCode !== 200) {
            this.server.log([this.cameraInfo.cameraId, 'error'], `Error obtaining Onvif RTSP streaming url`);
            return false;
        }

        const avaLivePipeline = await this.getPipelineContent(avaLivePipelineName);
        if (!avaLivePipeline) {
            return false;
        }

        const avaPipelineTopology = await this.getPipelineContent(avaPipelineTopologyName);
        if (!avaPipelineTopology) {
            return false;
        }

        this.avaPipeline = new AvaPipeline(this.server, this.avaEdgeModuleId, this.cameraInfo, getRtspStreamUrlResponse.payload, avaPipelineTopology, avaLivePipeline);
        if (!this.avaPipeline) {
            this.server.log([this.cameraInfo.cameraId, 'error'], `Error creating AvaPipeline object: {${avaPipelineTopologyName}:${avaLivePipelineName}}`);
            return false;
        }

        this.server.log([this.cameraInfo.cameraId, 'info'], `Successfully created AVA pipeline - topology: ${avaPipelineTopologyName}, live: ${avaLivePipelineName}`);

        if (this.debugTelemetry()) {
            this.server.log([this.cameraInfo.cameraId, 'info'], `Live Pipeline name: ${this.avaPipeline.livePipelineName}`);
            this.server.log([this.cameraInfo.cameraId, 'info'], `Live Pipeline content: ${JSON.stringify(this.avaPipeline.livePipeline, null, 4)}`);
            this.server.log([this.cameraInfo.cameraId, 'info'], `Pipeline Topology name: ${this.avaPipeline.pipelineTopologyName}`);
            this.server.log([this.cameraInfo.cameraId, 'info'], `Pipeline Topology content: ${JSON.stringify(this.avaPipeline.pipelineTopology, null, 4)}`);
        }

        return true;
    }

    private async startAvaProcessing(avaPipelineTopologyName: string, avaLivePipelineName: string, mediaProfileToken: string): Promise<boolean> {
        const initializeAvaProcessorResult = await this.initializeAvaProcessor(avaPipelineTopologyName, avaLivePipelineName, mediaProfileToken);

        if (!initializeAvaProcessorResult || !this.avaPipeline) {
            this.server.log([this.cameraInfo.cameraId, 'error'], `Could not create an instance of AVA pipeline`);
            return false;
        }

        const avaRecordingAssetName = `${this.appScopeId}-${this.iotCentralModule.deviceId}-${this.cameraInfo.cameraId}-${moment.utc().format('YYYYMMDD-HHmmss')}`;
        const startAvaPipelineResult = await this.avaPipeline.startAvaPipeline(avaRecordingAssetName);

        if (startAvaPipelineResult) {
            this.lastInferenceTime = moment.utc(0);
            this.videoInferenceStartTime = moment.utc();
            this.createVideoLinkForInferenceTimeout = false;

            this.inferenceInterval = setInterval(async () => {
                await this.inferenceTimer();
            }, 1000);
        }

        this.avaProcessingState = startAvaPipelineResult ? CameraProcessingState.Active : CameraProcessingState.Inactive;
        await this.sendMeasurement({
            [CameraCapability.stCameraProcessingState]: this.avaProcessingState
        });

        return startAvaPipelineResult;
    }

    private async stopAvaProcessing(): Promise<boolean> {
        clearInterval(this.inferenceInterval);
        this.inferenceInterval = null;

        if (!this.avaPipeline) {
            this.server.log([this.cameraInfo.cameraId, 'error'], `No AVA pipelne instance exists`);
            return;
        }

        const stopAvaPipelineResult = this.avaPipeline.stopAvaPipeline();

        this.avaProcessingState = CameraProcessingState.Inactive;
        await this.sendMeasurement({
            [CameraCapability.stCameraProcessingState]: this.avaProcessingState
        });

        return stopAvaPipelineResult;
    }

    private async restartCamera(): Promise<boolean> {
        this.server.log([this.cameraInfo.cameraId, 'info'], `restartCamera`);

        let result = true;

        try {
            const requestParams = {
                Address: this.cameraInfo.ipAddress,
                Username: this.cameraInfo.onvifUsername,
                Password: this.cameraInfo.onvifPassword
            };

            const restartResult = await this.server.settings.app.iotCentralModule.invokeDirectMethod(
                this.onvifModuleId,
                'Reboot',
                requestParams);

            if (restartResult.status >= 200 && restartResult.status < 300) {
                this.server.log([this.cameraInfo.cameraId, 'info'], `Camera restart command completed`);
            }
            else {
                this.server.log([this.cameraInfo.cameraId, 'error'], `An error occurred while attempting to restart the camera device`);
                result = false;
            }
        }
        catch (ex) {
            this.server.log([this.cameraInfo.cameraId, 'error'], `Error while attempting to restart camera (${this.cameraInfo.cameraId}): ${ex.message}`);
            result = false;
        }

        return result;
    }

    @bind
    private async handleDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log([this.cameraInfo.cameraId, 'info'], `${commandRequest.methodName} command received`);

        let response: DeviceCommandResponse = {
            statusCode: 200,
            message: ''
        };

        try {
            switch (commandRequest.methodName) {
                case OnvifCameraCapability.cmGetOnvifCameraProps: {
                    response = await this.getOnvifCameraProps();
                    break;
                }

                case OnvifCameraCapability.cmGetOnvifMediaProfiles: {
                    response = await this.getOnvifMediaProfiles();
                    break;
                }

                case OnvifCameraCapability.cmGetOnvifRtspStreamUrl: {
                    const mediaProfileToken = (commandRequest?.payload as IGetOnvifRtspStreamUrlCommandRequestParams)?.mediaProfileToken;
                    if (!mediaProfileToken) {
                        response.statusCode = 400;
                        response.message = `Missing required parameters for command ${commandRequest.methodName}`;
                    }
                    else {
                        response = await this.getOnvifRtspStreamUrl(mediaProfileToken);
                    }

                    break;
                }

                case CameraCapability.cmStartAvaPipeline: {
                    const startPipelineParams = commandRequest?.payload as IStartAvaPipelineCommandRequestParams;
                    if (!startPipelineParams.avaPipelineTopologyName
                        || !startPipelineParams.avaLivePipelineName
                        || !startPipelineParams.mediaProfileToken) {
                        response.statusCode = 400;
                        response.message = `Missing required parameters for command ${commandRequest.methodName}`;
                    }
                    else {
                        const startAvaPipelineResult = await this.startAvaProcessing(
                            startPipelineParams.avaPipelineTopologyName,
                            startPipelineParams.avaLivePipelineName,
                            startPipelineParams.mediaProfileToken);
                        if (startAvaPipelineResult) {
                            response.statusCode = 200;
                            response.message = `AVA edge processing started`;
                        }
                        else {
                            response.statusCode = 500;
                            response.message = `AVA edge processing failed to start`;
                        }
                    }

                    break;
                }

                case CameraCapability.cmStopAvaPipeline: {
                    const stopAvaPipelineResult = await this.stopAvaProcessing();
                    if (stopAvaPipelineResult) {
                        response.statusCode = 200;
                        response.message = `AVA edge processing stopped`;
                    }
                    else {
                        response.statusCode = 500;
                        response.message = `AVA edge processing failed to stop`;
                    }

                    break;
                }

                case OnvifCameraCapability.cmCaptureOnvifImage: {
                    const mediaProfileToken = (commandRequest?.payload as ICaptureOnvifImageCommandRequestParams)?.mediaProfileToken;
                    if (!mediaProfileToken) {
                        response.statusCode = 400;
                        response.message = `Missing required parameters for command ${commandRequest.methodName}`;
                    }
                    else {
                        response = await this.captureImage(mediaProfileToken);
                    }

                    break;
                }

                case CameraCapability.cmGetAvaProcessingStatus:
                    response.statusCode = 200;
                    response.message = this.processingState;
                    response.payload = this.processingState;
                    break;

                case OnvifCameraCapability.cmRestartOnvifCamera: {
                    await this.stopAvaProcessing();

                    const restartCameraResult = await this.restartCamera();
                    if (restartCameraResult) {
                        response.statusCode = 200;
                        response.message = `Camera restart command completed`;
                    }
                    else {
                        response.statusCode = 500;
                        response.message = `An error occurred while attempting to restart the camera device`;
                    }

                    break;
                }

                default:
                    response.statusCode = 400;
                    response.message = `An unknown method name was found: ${commandRequest.methodName}`;
            }

            this.server.log([this.cameraInfo.cameraId, 'info'], response.message);
        }
        catch (ex) {
            response.statusCode = 500;
            response.message = `An error occurred executing the command ${commandRequest.methodName}: ${ex.message}`;

            this.server.log([this.cameraInfo.cameraId, 'error'], response.message);
        }

        await commandResponse.send(200, response);
    }
}
