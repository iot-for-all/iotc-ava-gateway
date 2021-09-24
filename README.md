# Azure IoT Central gateway module for Azure Video Analyzer
This sample demonstrates how to use Azure IoT Central to ingest AI inferencing from intelligent video cameras managed by Azure Video Analyer on the edge. The sample includes a custom Azure IoT Edge gateway module and deployment manifest to deploy all the necessary components to create intelligent camera devices.

The full documentation for IoT Central support for Azure IoT Edge devices can be found at [Connect Azure IoT Edge devices to an Azure IoT Central application](https://docs.microsoft.com/en-us/azure/iot-central/core/concepts-iot-edge)

The full documentation for Azure Video Analyzer can be found at [What is Azure Video Analyzer?](https://docs.microsoft.com/en-us/azure/azure-video-analyzer/video-analyzer-docs/overview)

The following Azure Video Analyzer documentation can be used as a guide: [Quickstart: Detect motion and record video on edge devices](https://docs.microsoft.com/en-us/azure/azure-video-analyzer/video-analyzer-docs/detect-motion-record-video-edge-devices?pivots=programming-language-csharp), which shows you how to use Azure Video Analyzer to analysze the live video feed from a simulated IP camera and detect if any motion is present. The steps below will callout how to adapt IoT Central into the quickstart instead of using IoT Hub directly.

A quick note about the documentation and the differences between using IoT Hub vs. IoT Central. IoT Central is a managed application platform as a service. IoT Central is built on top of the Azure IoT platform using underlying IoT Hubs. IoT Central does not allow direct access to the underlying IoT Hub resources (e.g. via a connection string) since these are managed for you and may change based on scale, migration, fail-over, and other scenarios. Instead, devices are created via SAS keys, Certificates, or other methods against the [IoT Hub Device Provisioning Service](https://docs.microsoft.com/en-us/azure/iot-dps/about-iot-dps) to allow provisioning to the right IoT Hub in a scalable manner.

Start the [tutorial linked above](https://docs.microsoft.com/en-us/azure/azure-video-analyzer/video-analyzer-docs/detect-motion-record-video-edge-devices?pivots=programming-language-csharp) and ignore the lanaguage choice of CSharp or Python. This repository is written in Node.js and TypeScript and will be used instead.

## Prerequisites
* An Azure account that includes an active subscription.[Create an account for free](https://azure.microsoft.com/free/?WT.mc_id=A261C142F) if you don't already have one.
  > Note
  >
  >You will need an Azure subscription where you have access to both Contributor role, and User Access Administrator role. If you do not have the right permissions, please reach out to your account administrator to grant you those permissions.
* [Node.js](https://nodejs.org/en/download/) v14 or later
* [Visual Studio Code](https://code.visualstudio.com/Download) with [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) extension installed
* [Docker](https://www.docker.com/products/docker-desktop) engine
* An [Azure Container Registry](https://docs.microsoft.com/azure/container-registry/) to host your versions of the modules

## Clone the repository and setup project
1. If you haven't already cloned the repository, use the following command to clone it to a suitable location on your local machine:
    ```
    git clone https://github.com/tbd
    ```

1. Run the install command in the cloned directory. This command installs the required packages and runs the setup scripts.
   ```
   npm install
   ```
   As part of npm install a postInstall script is run to setup your development environment. This includes  
   * Creating a `./configs` directory to store your working files. This directory is configured to be ignored by Git so as to prevent you accidentally checking in any confidential secrets.
   * The `./configs` directory will include your working files:
     * `imageConfig.json` - defines the docker container image name
     * `./mediaPipelines` - a folder containing the media pipeline files that you can edit. If you have any instance variables you would set them here in the `objectPipelineInstance.json` or the `motionPipelineInstance.json` file. An example would be the `inferencingUrl` variable used to call the Yolov3 module.
     * `./deploymentManifests` - a folder containing the Edge deployment manifest files for various cpu architectures and deployment configurations.

1. Edit the *./configs/imageConfig.json* file to update the image name based on the container registry name that you use:
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



## Developer Notes
This repository is open to freely copy and uses as you see fit. It is intended to provide a reference for a developer to use as a base and which can lead to a specific solution.

In order to debug 

