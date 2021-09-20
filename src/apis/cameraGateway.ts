import { inject, RoutePlugin, route } from 'spryly';
import { Request, ResponseObject, ResponseToolkit } from '@hapi/hapi';
import {
    ICameraProvisionInfo,
    CameraGatewayService
} from '../services/cameraGateway';
import {
    badRequest as boom_badRequest,
    badImplementation as boom_badImplementation
} from '@hapi/boom';
import { emptyObj } from '../utils';

export class CameraGatewayRoutes extends RoutePlugin {
    @inject('cameraGateway')
    private cameraGateway: CameraGatewayService;

    @route({
        method: 'POST',
        path: '/api/v1/module/camera/{cameraId}',
        options: {
            tags: ['module'],
            description: 'Create a camera device'
        }
    })
    public async postCreateCamera(request: Request, h: ResponseToolkit): Promise<ResponseObject> {
        try {
            const cameraInfo: ICameraProvisionInfo = {
                cameraId: request.params?.cameraId,
                cameraName: (request.payload as any)?.cameraName,
                ipAddress: (request.payload as any)?.ipAddress,
                onvifUsername: (request.payload as any)?.onvifUsername,
                onvifPassword: (request.payload as any)?.onvifPassword
            };

            if (!cameraInfo.cameraId
                || !cameraInfo.cameraName
                || !cameraInfo.ipAddress
                || !cameraInfo.onvifUsername
                || !cameraInfo.onvifPassword) {
                throw boom_badRequest('Missing parameters (cameraId, cameraName, detectionType)');
            }

            const dpsProvisionResult = await this.cameraGateway.createCamera(cameraInfo);

            const resultMessage = dpsProvisionResult.dpsProvisionMessage || dpsProvisionResult.clientConnectionMessage;
            if (dpsProvisionResult.dpsProvisionStatus === false || dpsProvisionResult.clientConnectionStatus === false) {
                throw boom_badImplementation(resultMessage);
            }

            return h.response(resultMessage).code(201);
        }
        catch (ex) {
            throw boom_badRequest(ex.message);
        }
    }

    @route({
        method: 'DELETE',
        path: '/api/v1/module/camera/{cameraId}',
        options: {
            tags: ['module'],
            description: 'Delete a camera device'
        }
    })
    public async deleteCamera(request: Request, h: ResponseToolkit): Promise<ResponseObject> {
        try {
            const cameraId = request.params?.cameraId;
            if (!cameraId) {
                throw boom_badRequest('Missing cameraId');
            }

            const operationResult = await this.cameraGateway.deleteCamera({
                cameraId,
                operationInfo: {}
            });

            if (operationResult.status === false) {
                throw boom_badImplementation(operationResult.message);
            }

            return h.response(operationResult.message).code(204);
        }
        catch (ex) {
            throw boom_badRequest(ex.message);
        }
    }

    @route({
        method: 'POST',
        path: '/api/v1/module/camera/{cameraId}/telemetry',
        options: {
            tags: ['module'],
            description: 'Send telemetry to a device device'
        }
    })
    public async postSendCameraTelemetry(request: Request, h: ResponseToolkit): Promise<ResponseObject> {
        try {
            const cameraId = request.params?.cameraId;
            const telemetry = (request.payload as any)?.telemetry;

            if (!cameraId || !telemetry) {
                throw boom_badRequest('Missing cameraId or telemetry');
            }

            const operationResult = await this.cameraGateway.sendCameraTelemetry({
                cameraId,
                operationInfo: telemetry
            });

            if (operationResult.status === false) {
                throw boom_badImplementation(operationResult.message);
            }

            return h.response(operationResult.message).code(201);
        }
        catch (ex) {
            throw boom_badRequest(ex.message);
        }
    }

    @route({
        method: 'POST',
        path: '/api/v1/module/camera/{cameraId}/inferences',
        options: {
            tags: ['module'],
            description: 'Send inference telemetry to a camera device'
        }
    })
    public async postSendCameraInferenceTelemetry(request: Request, h: ResponseToolkit): Promise<ResponseObject> {
        try {
            const cameraId = request.params?.cameraId;
            const inferences = (request.payload as any)?.inferences;

            if (!cameraId || emptyObj(inferences)) {
                throw boom_badRequest('Missing cameraId or telemetry');
            }

            const operationResult = await this.cameraGateway.sendCameraInferences({
                cameraId,
                operationInfo: inferences
            });

            if (operationResult.status === false) {
                throw boom_badImplementation(operationResult.message);
            }

            return h.response(operationResult.message).code(201);
        }
        catch (ex) {
            throw boom_badRequest(ex.message);
        }
    }
}
