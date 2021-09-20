import { manifest } from './manifest';
import { compose, ComposeOptions } from 'spryly';
import {
    type as osType,
    cpus as osCpus,
    freemem as osFreeMem,
    totalmem as osTotalMem
} from 'os';
import { forget } from './utils';

const composeOptions: ComposeOptions = {
    relativeTo: __dirname,
    logCompose: {
        serializers: {
            req: (req) => {
                return `${(req.method || '').toUpperCase()} ${req.headers?.host} ${req.url}`;
            },
            res: (res) => {
                return `${res.statusCode} ${res.raw?.statusMessage}`;
            },
            tags: (tags) => {
                return `[${tags}]`;
            },
            responseTime: (responseTime) => {
                return `${responseTime}ms`;
            }
        },
        prettyPrint: {
            colorize: true,
            messageFormat: '{tags} {data} {req} {res} {responseTime}',
            translateTime: 'SYS:yyyy-mm-dd"T"HH:MM:sso',
            ignore: 'pid,hostname,tags,data,req,res,responseTime'
        }
    }
};

// process.on('unhandledRejection', (e: any) => {
/* eslint-disable */
//     console.log(['startup', 'error'], `Excepction on startup... ${e.message}`);
//     console.log(['startup', 'error'], e.stack);
/* eslint-enable */
// });

async function start() {
    try {
        const server = await compose(manifest(), composeOptions);

        const stopServer = async () => {
            server.log(['shutdown', 'info'], '☮︎ Stopping hapi server');
            await server.stop({ timeout: 10000 });

            server.log(['shutdown', 'info'], `⏏︎ Server stopped`);
            process.exit(0);
        };

        process.on('SIGINT', stopServer);
        process.on('SIGTERM', stopServer);

        server.log(['startup', 'info'], `🚀 Starting HAPI server instance...`);
        await server.start();

        server.log(['startup', 'info'], `✅ Core server started`);
        server.log(['startup', 'info'], `🌎 ${server.info.uri}`);
        server.log(['startup', 'info'], ` > Hapi version: ${server.version}`);
        server.log(['startup', 'info'], ` > Plugins: [${Object.keys(server.registrations).join(', ')}]`);
        server.log(['startup', 'info'], ` > Machine: ${osType()}, ${osCpus().length} core, ` +
            `freemem=${(osFreeMem() / 1024 / 1024).toFixed(0)}mb, totalmem=${(osTotalMem() / 1024 / 1024).toFixed(0)}mb`);
    }
    catch (error) {
        // eslint-disable-next-line no-console
        console.log(`['startup', 'error'], 👹 Error starting server: ${error.message}`);
    }
}

forget(start);
