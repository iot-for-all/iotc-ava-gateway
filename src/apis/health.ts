import { inject, RoutePlugin, route } from 'spryly';
import { Request, ResponseObject, ResponseToolkit } from '@hapi/hapi';
import { HealthService, HealthState } from '../services/health';
import {
    badRequest as boom_badRequest
} from '@hapi/boom';

export class HealthRoutes extends RoutePlugin {
    @inject('health')
    private health: HealthService;

    @route({
        method: 'GET',
        path: '/health',
        options: {
            tags: ['health'],
            description: 'Health status',
            auth: false
        }
    })
    // @ts-ignore (request)
    public async getHealth(request: Request, h: ResponseToolkit): Promise<ResponseObject> {
        try {
            const healthState = await this.health.checkHealthState();

            return h.response(`HealthState: ${healthState}`).code(healthState < HealthState.Good ? 400 : 200);
        }
        catch (ex) {
            throw boom_badRequest(ex.message);
        }
    }
}
