import { service, inject } from 'spryly';
import { Server } from '@hapi/hapi';
import { CameraGatewayService } from './cameraGateway';
import { bind } from '../utils';

export const healthCheckInterval = 15;
// const healthCheckTimeout = 30;
// const healthCheckStartPeriod = 60;
// const healthCheckRetries = 3;

export enum HealthState {
    Good = 2,
    Warning = 1,
    Critical = 0
}

@service('health')
export class HealthService {
    @inject('$server')
    private server: Server;

    @inject('cameraGateway')
    private cameraGateway: CameraGatewayService;

    // private heathCheckStartTime = Date.now();
    // private failingStreak = 1;

    public async init(): Promise<void> {
        this.server.log(['HealthService', 'info'], 'initialize');
    }

    @bind
    public async checkHealthState(): Promise<number> {
        const moduleHealth = await this.cameraGateway.getHealth();

        this.server.log(['HealthService', 'info'], `Health check state: ${HealthState[moduleHealth]}`);

        return moduleHealth;
    }
}
