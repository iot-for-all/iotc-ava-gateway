import { HapiPlugin, inject } from 'spryly';
import { Server } from '@hapi/hapi';
import {
    resolve as pathResolve,
    relative as pathRelative,
    isAbsolute as pathIsAbsolute,
    parse as pathParse
} from 'path';
import * as fse from 'fs-extra';
import * as _get from 'lodash.get';
import * as _set from 'lodash.set';

export interface IConfig {
    get(scope: string, property?: string): Promise<any>;
    set(scope: string, property: any, value?: any): Promise<void>;
    clear(scope: string): Promise<boolean>;
}

declare module '@hapi/hapi' {
    interface ServerOptionsApp {
        config?: IConfig;
    }
}

const ROOT = '__ROOT__';
const PluginName = 'ConfigPlugin';
const ModuleName = 'ConfigModule';

export class ConfigPlugin implements HapiPlugin {
    @inject('$server')
    private server: Server;

    public async init(): Promise<void> {
        this.server.log([PluginName, 'info'], `init`);
    }

    // @ts-ignore (options)
    public async register(server: Server, options: any): Promise<void> {
        server.log([PluginName, 'info'], 'register');

        try {
            const plugin = new ConfigModule(server, options);

            await plugin.initialize();

            server.settings.app.config = plugin;
        }
        catch (ex) {
            server.log([PluginName, 'error'], `Error while registering : ${ex.message}`);
        }
    }
}

class ConfigModule implements IConfig {
    private server: Server;
    private storageDirectory: string;

    // @ts-ignore (options)
    constructor(server: Server, options: any) {
        this.server = server;
    }

    public async initialize(): Promise<boolean> {
        this.server.log([ModuleName, 'info'], 'initialize');

        this.storageDirectory = this.server.settings.app.storageRootDirectory;

        return true;
    }

    public async get(scope: string, property?: string): Promise<any> {
        if (!property) {
            property = ROOT;
        }

        const obj = await this.readScope(scope);

        if (!obj) {
            return {};
        }

        if (property === ROOT) {
            return obj;
        }

        return _get(obj, property);
    }

    public async set(scope: string, property: any, value?: any): Promise<void> {
        if (!value) {
            value = property;
            property = ROOT;
        }

        const obj = await this.readScope(scope);

        const finalObject = (property === ROOT)
            ? value
            : _set(obj || {}, property, value);

        this.writeScope(scope, finalObject);
    }

    public async clear(scope: string): Promise<boolean> {
        // Only clear out the directory if it is a sub-directory of our known /data/storage path
        const relative = pathRelative(this.storageDirectory, scope);
        if (relative && !relative.startsWith('..') && !pathIsAbsolute(relative)) {
            await fse.emptyDir(pathResolve(this.storageDirectory, scope));
            return true;
        }

        return false;
    }

    private async readScope(scope: string): Promise<any> {
        try {
            const exists = await fse.pathExists(this.getScopePath(scope));
            if (!exists) {
                return {};
            }

            return fse.readJson(this.getScopePath(scope));
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Error reading scope: ${scope}`);

            return {};
        }
    }

    private writeScope(scope: string, data: any): void {
        try {
            const writeOptions = {
                spaces: 2,
                throws: false
            };

            const fullPath = this.getScopePath(scope);
            const parsedPath = pathParse(fullPath);
            fse.ensureDirSync(parsedPath.dir);

            fse.writeJsonSync(fullPath, data, writeOptions);
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Config write failed for scope ${scope}: ${ex.message}`);
        }
    }

    private getScopePath(scope: string) {
        return pathResolve(this.storageDirectory, `${scope}.json`);
    }
}
