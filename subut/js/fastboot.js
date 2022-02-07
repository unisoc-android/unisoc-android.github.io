const FASTBOOT_USB_CLASS = 0xff;
const FASTBOOT_USB_SUBCLASS = 0x42;
const FASTBOOT_USB_PROTOCOL = 0x03;

const BULK_TRANSFER_SIZE = 16384;

/**
 * Exception class for USB errors not directly thrown by WebUSB.
 */
export class UsbError extends Error {
    constructor(message) {
        super(message);
        this.name = "UsbError";
    }
}

/**
 * Exception class for errors returned by the bootloader, as well as high-level
 * fastboot errors resulting from bootloader responses.
 */
export class FastbootError extends Error {
    constructor(status, message) {
        super(`Bootloader replied with ${status}: ${message}`);
        this.status = status;
        this.bootloaderMessage = message;
        this.name = "FastbootError";
    }
}

/**
 * This class is a client for executing fastboot commands and operations on a
 * device connected over USB.
 */
export class FastbootDevice {
    /**
     * Create a new fastboot device instance. This doesn't actually connect to
     * any USB devices; call {@link connect} to do so.
     */
    constructor() {
        this.device = null;
        this.epIn = null;
        this.epOut = null;
        this._registeredUsbListener = false;
    }

    /**
     * Validate the current USB device's details and connect to it.
     *
     * @private
     */
    async _validateAndConnectDevice(rethrowErrors) {
        this.epIn = null;
        this.epOut = null;

        let ife = this.device.configurations[0].interfaces[0].alternates[0];
        for (let endpoint of ife.endpoints) {
            console.debug("Checking endpoint:", endpoint);
            if (endpoint.type !== "bulk") {
                console.debug("Endpoint type not bulk. Ignoring...")
                continue;
            }

            if (endpoint.direction === "in") {
                if (this.epIn !== null) {
                    throw new UsbError("Interface has multiple IN endpoints");
                }
                this.epIn = endpoint.endpointNumber;
            } else if (endpoint.direction === "out") {
                if (this.epOut !== null) {
                    throw new UsbError("Interface has multiple OUT endpoints");
                }
                this.epOut = endpoint.endpointNumber;
            }
        }
        if (this.epIn == null || this.epOut == null) {
            throw new UsbError("Could not find the required IN and OUT endpoints")
        }

        console.debug("Endpoints: in =", this.epIn, ", out =", this.epOut);

        try {
            await this.device.open();
            // Opportunistically reset to fix issues on some platforms
            try {
                await this.device.reset();
            } catch (error) {
                /* Failed = doesn't support reset */
            }

            await this.device.selectConfiguration(1);
            await this.device.claimInterface(0);
        } catch (error) {
            if (rethrowErrors) {
                throw error;
            }
        }
    }

    /**
     * Request the user to select a USB device and connect to it using the
     * fastboot protocol.
     *
     * @throws {UsbError}
     */
    async connect() {
        this.device = await navigator.usb.requestDevice({
            filters: [
                {
                    classCode: FASTBOOT_USB_CLASS,
                    subclassCode: FASTBOOT_USB_SUBCLASS,
                    protocolCode: FASTBOOT_USB_PROTOCOL,
                },
            ],
        });
        console.log("Using USB device:", this.device);

        if (!this._registeredUsbListener) {
            navigator.usb.addEventListener("disconnect", (event) => {
                if (event.device === this.device) {
                    console.log("USB device disconnected");
                }
            });

            this._registeredUsbListener = true;
        }

        await this._validateAndConnectDevice(true);
    }

    /**
     * Read a raw command response from the bootloader.
     *
     * @returns {response} Object containing response text and data size, if any.
     * @throws {FastbootError}
     */
    async readResponse() {
        let returnData = {
            text: "",
            dataSize: null,
        };
        let respStatus;
        do {
            let respPacket = await this.device.transferIn(this.epIn, 64);
            let response = new TextDecoder().decode(respPacket.data);

            respStatus = response.substring(0, 4);
            let respMessage = response.substring(4);
            console.log(`Response: ${respStatus} ${respMessage}`);

            if (respStatus === "OKAY") {
                // OKAY = end of response for this command
                returnData.text += respMessage;
            } else if (respStatus === "INFO") {
                // INFO = additional info line
                returnData.text += respMessage + "\n";
            } else if (respStatus === "DATA") {
                // DATA = hex string, but it's returned separately for safety
                returnData.dataSize = respMessage;
            } else {
                // Assume FAIL or garbage data
                throw new FastbootError(respStatus, respMessage);
            }
            // INFO means that more packets are coming
        } while (respStatus === "INFO");

        return returnData;
    }

    /**
     * Send a textual command to the bootloader.
     * This is in raw fastboot format, not AOSP fastboot syntax.
     *
     * @param {string} command - The command to send.
     * @returns {response} Object containing response text and data size, if any.
     * @throws {FastbootError}
     */
    async runCommand(command) {
        // Command and response length is always 64 bytes regardless of protocol
        if (command.length > 64) {
            throw new RangeError();
        }

        // Send raw UTF-8 command
        let cmdPacket = new TextEncoder().encode(command);
        await this.device.transferOut(this.epOut, cmdPacket);
        console.log("Command:", command);

        return this.readResponse();
    }

    /**
     * Callback for progress updates while flashing or uploading an image.
     *
     * @callback ProgressCallback
     * @param {number} progress - Progress for the current action, between 0 and 1.
     */

    /**
     * Send a raw data payload to the bootloader.
     */
    async sendRawPayload(buffer, onProgress) {
        let i = 0;
        let remainingBytes = buffer.byteLength;
        while (remainingBytes > 0) {
            let chunk = buffer.slice(
                i * BULK_TRANSFER_SIZE,
                (i + 1) * BULK_TRANSFER_SIZE
            );

            console.debug(`Sending ${chunk.byteLength} bytes to endpoint, ${remainingBytes} remaining, i=${i}`);
            onProgress((buffer.byteLength - remainingBytes) / buffer.byteLength);

            await this.device.transferOut(this.epOut, chunk);

            remainingBytes -= chunk.byteLength;
            i += 1;
        }

        onProgress(1.0);
    }
}