import { Server } from '@hapi/hapi';
import { IIotCentralPluginModule } from '../plugins/iotCentralModule';
import { ICameraProvisionInfo } from './cameraGateway';
import { Message as IoTMessage } from 'azure-iot-device';
import * as moment from 'moment';

const ModuleName = 'AvaPipeline';

enum AvaDirectMethodCommands {
    SetTopology = 'pipelineTopologySet',
    DeleteTopology = 'pipelineTopologyDelete',
    SetLivePipeline = 'livePipelineSet',
    DeleteLivePipeline = 'livePipelineDelete',
    ActivateLivePipeline = 'livePipelineActivate',
    DeactivateLivePipeline = 'livePipelineDeactivate'
}

export class AvaPipeline {
    public static getCameraIdFromAvaMessage(message: IoTMessage): string {
        const subject = AvaPipeline.getAvaMessageProperty(message, 'subject');
        if (subject) {
            const pipelinePathElements = subject.split('/');
            if (pipelinePathElements.length >= 5 && pipelinePathElements[3] === 'livePipelines') {
                const pipelineInstanceName = pipelinePathElements[4] || '';
                if (pipelineInstanceName) {
                    return pipelineInstanceName.substring(pipelineInstanceName.indexOf('_') + 1) || '';
                }
            }
        }

        return '';
    }

    public static getAvaMessageProperty(message: IoTMessage, propertyName: string): string {
        const messageProperty = (message.properties?.propertyList || []).find(property => property.key === propertyName);

        return messageProperty?.value || '';
    }

    private server: Server;
    private iotCentralPluginModule: IIotCentralPluginModule;
    private avaEdgeModuleId: string;
    private cameraInfo: ICameraProvisionInfo;
    private rtspUrlInternal: string;
    private avaPipelineTopologyInternal: any;
    private avaLivePipelineInternal: any;
    private avaRecordingAssetName: string;

    private avaPipelineTopologyObject: any;
    private avaLivePipelineObject: any;

    constructor(server: Server, cameraInfo: ICameraProvisionInfo, rtspUrl: string, avaPipelineTopology: any, avaLivePipeline: any) {
        this.server = server;
        this.iotCentralPluginModule = server.settings.app.iotCentral;
        this.avaEdgeModuleId = this.server.settings.app.cameraGateway.moduleEnvironmentConfig.avaEdgeModuleId;
        this.cameraInfo = cameraInfo;
        this.rtspUrlInternal = rtspUrl;
        this.avaPipelineTopologyInternal = avaPipelineTopology;
        this.avaLivePipelineInternal = avaLivePipeline;

        this.avaLivePipelineInternal.name = cameraInfo.cameraId;

        this.avaPipelineTopologyObject = {
            ['@apiVersion']: this.avaPipelineTopologyInternal['@apiVersion'],
            name: this.avaPipelineTopologyInternal.name
        };

        this.avaLivePipelineObject = {
            ['@apiVersion']: this.avaPipelineTopologyInternal['@apiVersion'],
            name: this.avaLivePipelineInternal.name
        };
    }

    public get rtspUrl(): string {
        return this.rtspUrlInternal;
    }

    public get pipelineTopologyName(): string {
        return this.avaPipelineTopologyObject?.name || '';
    }

    public get livePipelineName(): string {
        return this.avaLivePipelineObject?.name || '';
    }

    public get pipelineTopology(): any {
        return this.avaPipelineTopologyInternal;
    }

    public get livePipeline(): any {
        return this.avaLivePipelineInternal;
    }

    public async startAvaPipeline(avaRecordingAssetName: string): Promise<boolean> {
        this.server.log([ModuleName, this.cameraInfo.cameraId, 'info'], `startAvaPipeline`);

        let result = false;
        this.avaRecordingAssetName = avaRecordingAssetName;

        try {
            result = await this.setTopologyPipeline();

            if (result) {
                result = await this.setLivePipeline();
            }

            if (result) {
                result = await this.activateLivePipeline();
            }
        }
        catch (ex) {
            this.server.log([ModuleName, this.cameraInfo.cameraId, 'error'], `startAvaPipeline error: ${ex.message}`);
        }

        return result;
    }

    public async stopAvaPipeline(): Promise<boolean> {
        this.server.log([ModuleName, this.cameraInfo.cameraId, 'info'], `stopAvaPipeline`);

        let result = false;

        try {
            // await this.deactivateLivePipeline();
            await this.deleteAvaPipeline();

            result = true;
        }
        catch (ex) {
            this.server.log([ModuleName, this.cameraInfo.cameraId, 'error'], `stopAvaPipeline error: ${ex.message}`);
        }

        return result;
    }

    public async deleteAvaPipeline(): Promise<boolean> {
        this.server.log([ModuleName, this.cameraInfo.cameraId, 'info'], `deleteAvaPipeline`);

        let result = false;

        try {
            await this.deactivateLivePipeline();
            await this.deleteLivePipeline();
            await this.deletePipelineTopology();

            result = true;
        }
        catch (ex) {
            this.server.log([ModuleName, this.cameraInfo.cameraId, 'error'], `deleteAvaPipeline error: ${ex.message}`);
        }

        return result;
    }

    public createInferenceVideoLink(videoPlaybackHost: string, startTime: moment.Moment, duration: number): string {
        if (videoPlaybackHost.slice(-1) === '/') {
            videoPlaybackHost = videoPlaybackHost.slice(0, -1);
        }

        return `${videoPlaybackHost}/ampplayer?an=${this.avaRecordingAssetName}&st=${startTime.format('YYYY-MM-DDTHH:mm:ss[Z]')}&du=${duration}`;
    }

    private async setTopologyPipeline(): Promise<boolean> {
        const response = await this.iotCentralPluginModule.invokeDirectMethod(this.avaEdgeModuleId, AvaDirectMethodCommands.SetTopology, this.avaPipelineTopologyInternal);

        return response.status >= 200 && response.status < 300;
    }

    private async deletePipelineTopology(): Promise<boolean> {
        const response = await this.iotCentralPluginModule.invokeDirectMethod(this.avaEdgeModuleId, AvaDirectMethodCommands.DeleteTopology, this.avaPipelineTopologyObject);

        return response.status >= 200 && response.status < 300;
    }

    public setLivePipelineParam(paramName: string, value: any): void {
        if (!paramName || value === undefined) {
            this.server.log([ModuleName, this.cameraInfo.cameraId, 'error'], `setInstanceParam error - param: ${paramName}, value: ${value}`);
            return;
        }

        const params = this.avaLivePipelineInternal.properties?.parameters || [];
        const param = params.find(item => item.name === paramName);
        if (!param) {
            this.server.log([ModuleName, this.cameraInfo.cameraId, 'warning'], `setInstanceParam no param named: ${paramName}`);
            return;
        }

        param.value = value;
    }

    private async setLivePipeline(): Promise<boolean> {
        this.setLivePipelineParam('rtspUrl', this.rtspUrlInternal);
        this.setLivePipelineParam('rtspAuthUsername', this.cameraInfo.username);
        this.setLivePipelineParam('rtspAuthPassword', this.cameraInfo.password);
        this.setLivePipelineParam('assetName', this.avaRecordingAssetName);

        const response = await this.iotCentralPluginModule.invokeDirectMethod(this.avaEdgeModuleId, AvaDirectMethodCommands.SetLivePipeline, this.avaLivePipelineInternal);

        return response.status >= 200 && response.status < 300;
    }

    private async deleteLivePipeline(): Promise<boolean> {
        const response = await this.iotCentralPluginModule.invokeDirectMethod(this.avaEdgeModuleId, AvaDirectMethodCommands.DeleteLivePipeline, this.avaLivePipelineObject);

        return response.status >= 200 && response.status < 300;
    }

    private async activateLivePipeline(): Promise<boolean> {
        const response = await this.iotCentralPluginModule.invokeDirectMethod(this.avaEdgeModuleId, AvaDirectMethodCommands.ActivateLivePipeline, this.avaLivePipelineObject);

        return response.status >= 200 && response.status < 300;
    }

    private async deactivateLivePipeline(): Promise<boolean> {
        const response = await this.iotCentralPluginModule.invokeDirectMethod(this.avaEdgeModuleId, AvaDirectMethodCommands.DeactivateLivePipeline, this.avaLivePipelineObject);

        return response.status >= 200 && response.status < 300;
    }
}
