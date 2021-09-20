import { Server, Plugin } from '@hapi/hapi';
import {
    ContainerCreateOptions,
    BlobServiceClient,
    ContainerClient
} from '@azure/storage-blob';
import { Readable } from 'stream';

export interface IBlobStoragePluginOptions {
    blobConnectionString: string;
    blobPipelineContainer: string;
    blobImageCaptureContainer: string;
}

export interface IBlobStorage {
    getFileFromBlobStorage(fileName: string): Promise<any>;
    uploadBase64ImageToContainer(base64Data: string, blobName: string): Promise<string>;
}

declare module '@hapi/hapi' {
    interface ServerOptionsApp {
        blobStorage?: IBlobStorage;
    }
}

const PluginModuleName = 'BlobStoragePlugin';
const ModuleName = 'BlobStorageModule';

export const blobStoragePlugin: Plugin<any> = {
    name: PluginModuleName,

    // @ts-ignore (server, options)
    register: async (server: Server, options: IBlobStoragePluginOptions) => {
        server.log([PluginModuleName, 'info'], 'register');

        if (!options.blobConnectionString) {
            throw new Error('Missing required option (blobConnectionString) in IBlobStoragePluginOptions');
        }

        const plugin = new BlobStorageModule(server, options);

        await plugin.initialize();

        server.settings.app.blobStorage = plugin;
    }
};

class BlobStorageModule implements IBlobStorage {
    private server: Server;
    private options: IBlobStoragePluginOptions;
    private blobStorageServiceClient: BlobServiceClient;

    constructor(server: Server, options: IBlobStoragePluginOptions) {
        this.server = server;
        this.options = options;
    }

    public async initialize(): Promise<boolean> {
        if (!this.ensureBlobServiceClient()) {
            this.server.log([ModuleName, 'error'], `Error creating the Blob Storage Service client`);
            return;
        }

        return true;
    }

    public async getFileFromBlobStorage(fileName: string): Promise<any> {
        if (!this.ensureBlobServiceClient()) {
            this.server.log([ModuleName, 'error'], `No Blob Storage Service client for file download`);
            return;
        }

        try {
            const containerClient = this.blobStorageServiceClient.getContainerClient(this.options.blobPipelineContainer);
            const containerExists = await containerClient.exists();
            if (!containerExists) {
                this.server.log([ModuleName, 'error'], `The destination blob storage container does not exist: ${this.options.blobPipelineContainer}`);
                return;
            }

            const blobClient = containerClient.getBlobClient(fileName);

            const downloadBlockBlobResponse = await blobClient.download();
            const bufferData = await this.streamToBuffer(downloadBlockBlobResponse.readableStreamBody);

            return JSON.parse(bufferData.toString());
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Error while downloading blob file: ${ex.message}`);
        }

        return;
    }

    public async uploadBase64ImageToContainer(base64Data: string, blobName: string): Promise<string> {
        if (!this.ensureBlobServiceClient()) {
            this.server.log([ModuleName, 'error'], `No Blob Storage Service client for image upload`);
            return;
        }

        let imageUrl = '';

        try {
            this.server.log([ModuleName, 'info'], `Preparing to upload image content to blob storage container`);

            const containerClient = await this.ensureContainer(this.options.blobImageCaptureContainer, { access: 'container' });
            const blockBlobClient = containerClient.getBlockBlobClient(blobName);

            const bufferData = Buffer.from(base64Data, 'base64');
            const readableStream = new Readable({
                read() {
                    this.push(bufferData);
                    this.push(null);
                }
            });

            const uploadOptions = {
                blobHTTPHeaders: {
                    blobContentType: 'image/jpeg'
                }
            };

            const uploadResponse = await blockBlobClient.uploadStream(readableStream, bufferData.length, 5, uploadOptions);

            // eslint-disable-next-line no-underscore-dangle
            if (uploadResponse?._response.status === 201) {
                // eslint-disable-next-line no-underscore-dangle
                this.server.log([ModuleName, 'info'], `Success - status: ${uploadResponse?._response.status}, path: ${blockBlobClient.url}`);

                imageUrl = blockBlobClient.url;
            }
            else {
                // eslint-disable-next-line no-underscore-dangle
                this.server.log([ModuleName, 'info'], `Error while uploading content to blob storage - status: ${uploadResponse?._response.status}, code: ${uploadResponse?.errorCode}`);
            }
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Error while uploading content to blob storage container: ${ex.message}`);
        }

        return imageUrl;
    }

    private ensureBlobServiceClient(): boolean {
        try {
            if (!this.blobStorageServiceClient) {
                this.blobStorageServiceClient = BlobServiceClient.fromConnectionString(this.options.blobConnectionString);
            }

            return !!this.blobStorageServiceClient;
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Error creating the blob storage service shared key and client: ${ex.message}`);
        }

        return false;
    }

    private async ensureContainer(containerName: string, options?: ContainerCreateOptions): Promise<ContainerClient> {
        let blobStoreContainerClient;

        try {
            blobStoreContainerClient = this.blobStorageServiceClient.getContainerClient(containerName);

            const containerExists = await blobStoreContainerClient.exists();
            if (!containerExists) {
                const { containerClient, containerCreateResponse } = await this.blobStorageServiceClient.createContainer(containerName, options);
                // eslint-disable-next-line no-underscore-dangle
                if (containerCreateResponse?._response.status === 201) {
                    // eslint-disable-next-line no-underscore-dangle
                    this.server.log([ModuleName, 'info'], `Created blob storage container: ${containerCreateResponse?._response.status}, path: ${containerName}`);

                    blobStoreContainerClient = containerClient;
                }
                else {
                    // eslint-disable-next-line no-underscore-dangle
                    this.server.log([ModuleName, 'info'], `Error creating blob storage container: ${containerCreateResponse?._response.status}, code: ${containerCreateResponse?.errorCode}`);
                }
            }
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Error accessing blob store container ${containerName}: ${ex.message}`);
        }

        return blobStoreContainerClient;
    }

    private async streamToBuffer(readableStream): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const chunks = [];

            readableStream.on('data', (data) => {
                chunks.push(data instanceof Buffer ? data : Buffer.from(data));
            });

            readableStream.on('end', () => {
                resolve(Buffer.concat(chunks));
            });

            readableStream.on('error', reject);
        });
    }
}
