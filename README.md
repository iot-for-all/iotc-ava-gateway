# Azure IoT Central gateway module for Live Video Analytics
Live Video Analytics on IoT Edge. It is used when you build and deploy an app for analyzing live video using an Azure IoT Central app template. The full tutorial showing how to modify and use this IoT Edge module code can be found at [Tutorial: Build and register the AVA Gateway Module](https://docs.microsoft.com/azure/iot-central/retail/tutorial-video-analytics-build-module).

To learn how to use Live Video Analytics on IoT Edge see the full documentation at [Live Video Analytics on IoT Edge documentation](https://docs.microsoft.com/en-us/azure/media-services/live-video-analytics-edge/).

## Prerequisites
To complete the steps in this tutorial, you need:
* [Node.js](https://nodejs.org/en/download/) v13 or later
* [Visual Studio Code](https://code.visualstudio.com/Download) with [TSLint](https://marketplace.visualstudio.com/items?itemName=ms-vscode.vscode-typescript-tslint-plugin) extension installed
* [Docker](https://www.docker.com/products/docker-desktop) engine
  * This project relies on Docker buildx to build multi-architecture container images. Please see the [Github multi-arch/qemu-user-static](https://github.com/multiarch/qemu-user-static) project to install the qemu-user-static support.
* An [Azure Container Registry](https://docs.microsoft.com/azure/container-registry/) to host your versions of the modules
* An [Azure Media Services](https://docs.microsoft.com/azure/media-services/) account.

## Clone the repository and setup project
1. If you haven't already cloned the repository, use the following command to clone it to a suitable location on your local machine:
    ```
    git clone https://github.com/Azure/live-video-analytics
    ```

1. Open the cloned **live-video-analytics** repository and cd into the *ref-apps/ava-edge-iot-central-gateway* folder with VS Code.

1. Run the install command. This command installs the required packages and runs the setup scripts.
   ```
   npm install
   ```
   As part of npm install a postInstall script is run to setup your development environment. This includes  
   * Creating a `./configs` directory to store your working files. This directory is configured to be ignored by Git so as to prevent you accidentally checking in any confidential secrets.
   * The `./configs` directory will include your working files:
     * `imageConfig.json` - defines the docker container image name
     * `state.json` - defines the properties read from the Edge device at runtime
     * `./mediaPipelines` - a folder containing the media pipeline files that will be included into your docker container image. If you have any fixed instance variables you would set them here in the `objectPipelineInstance.json` or the `motionPipelineInstance.json` file. An example would be the `inferencingUrl` variable used to call the Yolov3 module.
     * `./deploymentManifests` - a folder containing the Edge deployment manifest files for various cpu architectures and deployment configurations.

1. Edit the *./setup/imageConfig.json* file to update the image named based on your container registry name:
    ```
    {
        "arch": "[amd64|arm64v8]",
        "imageName": "[Server].azurecr.io/ava-edge-gateway",
        "versionTag": "latest"
    }
    ```

### Add Inference Endpoint for Custom Inference Service
In order to bring up your own custom inference service, you need to include the inference URL in *objectPipelineInstance.json*. Please follow below instructions to add value of inference URL.
1. In VS Code, open *./configs/mediaPipelines/objectPipelineInstance.json* file.
2. Edit the `inferencingUrl` parameter section to add value of `inference URL`(Line no.26). Below are the list of available inference endpoint values for AVA.

**OpenVINO™ Model Server**
- Vehicle Detection: http://OpenVINOModelServerEdgeAIExtensionModule:4000/vehicleDetection 
- Person Vehicle Bike Detection: http://OpenVINOModelServerEdgeAIExtensionModule:4000/personVehicleBikeDetection 
- Face Detection: http://OpenVINOModelServerEdgeAIExtensionModule:4000/vehicleDetection   

**YOLOv3**
- Object Detection: http://avaYolov3/score


### Edit the deployment.amd64.json file
1. In VS Code, open the the *configs/deploymentManifests/deployment.amd64.json* file. (Or, a specific deployment file that matches your scenario - e.g. OpenVINO, ARM64, etc.)
1. Edit the `registryCredentials` section to add your Azure Container Registry credentials.
1. See the [Create a Live Video Analytics application in Azure IoT Central](https://docs.microsoft.com/azure/iot-central/retail/tutorial-video-analytics-create-app) for more information about how to complete the configuration.

## Build the code
1. Use the VS Code terminal to run the docker login command. Use the same credentials that you provided in the deployment manifest for the modules.
    ```
    docker login [your server].azurecr.io
    ```

1. Use the VS Code terminal to run the commands to build the image and push it to your docker container registry. The build scripts deploy the image to your container registry. The output in the VS Code terminal window shows you if the build is successful.
    ```
    npm run dockerbuild
    npm run dockerpush
    ```

1. An alternative approach is to perform a multi-architecture docker container build. This requires [Docker Buildx](https://docs.docker.com/buildx/working-with-buildx/). After reading the documentation and configuration a buildx instance you can use the following command to build an image for linux/amd64 and linux/arm64
   ```
   docker buildx build --platform linux/amd64,linux/arm64 --push -f ./docker/Dockerfile -t <YOUR_CONTAINER_REGISTRY>/<YOUR_IMAGE_NAME>:latest .
   ```
   Note: add the `--progress=plain` flag to the buildx command to see verbose output that can help diagnose build issues.
