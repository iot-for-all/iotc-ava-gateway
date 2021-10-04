const childProcess = require('child_process');
const os = require('os');
const path = require('path');
const fse = require('fs-extra');
const { Command } = require('commander');

const programArgs = new Command()
    .option('-c, --config-file <configFile>', 'Build config file')
    .option('-b, --docker-build', 'Docker build the image')
    .option('-d, --debug', 'Use debug build options')
    .option('-p, --docker-push', 'Docker push the image')
    .option('-r, --workspace-root <workspaceRoot>', 'Workspace root folder path')
    .option('-v, --image-version <version>', 'Docker image version override')
    .parse(process.argv);
const programOptions = programArgs.opts();

const workspaceRootFolder = programOptions.workspaceRoot || process.cwd();

function log(message) {
    // eslint-disable-next-line no-console
    console.log(message);
}

async function execDockerBuild(dockerArch, dockerImage) {
    const dockerArgs = [
        'build',
        '-f',
        `docker/${dockerArch}.Dockerfile`,
        '-t',
        dockerImage,
        '.'
    ];

    childProcess.execFileSync('docker', dockerArgs, { stdio: [0, 1, 2] });
}

async function execDockerPush(dockerImage) {
    const dockerArgs = [
        'push',
        dockerImage
    ];

    childProcess.execFileSync('docker', dockerArgs, { stdio: [0, 1, 2] });
}

async function start() {
    let buildFailed = false;

    try {
        const configFile = programOptions.configFile || `imageConfig.json`;
        const imageConfigFilePath = path.resolve(workspaceRootFolder, `configs`, configFile);
        const imageConfig = fse.readJSONSync(imageConfigFilePath);
        const dockerVersion = imageConfig.versionTag || process.env.npm_package_version || programOptions.imageVersion || 'latest';
        const dockerArch = `${imageConfig.arch}${programOptions.debug ? '-debug' : ''}` || '';
        const dockerImage = `${imageConfig.imageName}:${dockerVersion}-${dockerArch}`;

        log(`Docker image: ${dockerImage}`);
        log(`Platform: ${os.type()}`);

        if (programOptions.dockerBuild) {
            await execDockerBuild(dockerArch, dockerImage);
        }

        if (programOptions.dockerPush) {
            await execDockerPush(dockerImage);
        }
    } catch (e) {
        log(`Exception: ${e.message}`);
        buildFailed = true;
    } finally {
        if (!buildFailed) {
            log(`Operation complete`);
        }
    }

    if (buildFailed) {
        log(`Operation failed, exiting...`);

        process.exit(-1);
    }
}

start();
