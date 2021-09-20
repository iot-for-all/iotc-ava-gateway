const os = require('os');
const path = require('path');
const fse = require('fs-extra');

const processArgs = require('commander')
    .option('-r, --workspace-root <workspaceRoot>', 'Workspace root folder path')
    .parse(process.argv);

const osType = os.type();
const workspaceRootFolder = processArgs.workspaceRoot || process.cwd();

function log(message) {
    // eslint-disable-next-line no-console
    console.log(message);
}

function createDevConfigurationFile(srcFile, dstFolder, dstFile) {
    if (!fse.pathExistsSync(dstFile)) {
        log(`Creating configuration: ${dstFile}`);

        fse.ensureDirSync(dstFolder);

        try {
            fse.copyFileSync(srcFile, dstFile);
        }
        catch (ex) {
            log(ex.message);
        }
    }
}

function createDevConfigurationFolder(srcFolder, dstFolder) {
    if (!fse.pathExistsSync(dstFolder)) {

        // fse.ensureDirSync(dstFolder);

        try {
            fse.copySync(srcFolder, dstFolder);
        }
        catch (ex) {
            const foo = ex.message;
        }
    }
}

function start() {
    log(`Creating workspace environment: ${workspaceRootFolder}`);
    log(`Platform: ${osType}`);

    let setupFailed = false;

    try {
        if (!workspaceRootFolder) {
            throw '';
        }

        const setupDirSrc = path.resolve(workspaceRootFolder, `setup`);
        const configDirDst = path.resolve(workspaceRootFolder, `configs`);

        createDevConfigurationFile(path.resolve(setupDirSrc, `imageConfig.json`), configDirDst, path.resolve(configDirDst, `imageConfig.json`));
        createDevConfigurationFile(path.resolve(setupDirSrc, `state.json`), configDirDst, path.resolve(configDirDst, `state.json`));
        createDevConfigurationFolder(path.resolve(setupDirSrc, `mediaPipelines`), path.resolve(configDirDst, `mediaPipelines`));
        createDevConfigurationFolder(path.resolve(setupDirSrc, `deploymentManifests`), path.resolve(configDirDst, `deploymentManifests`));
    } catch (e) {
        setupFailed = true;
    } finally {
        if (!setupFailed) {
            log(`Operation complete`);
        }
    }

    if (setupFailed) {
        log(`Operation failed, see errors above`);

        process.exit(-1);
    }
}

start();
