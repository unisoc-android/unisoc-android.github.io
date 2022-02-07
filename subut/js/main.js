import {FastbootDevice, FastbootError} from "./fastboot.js";
import {default as defaultKey} from "../assets/default_key.js";

const device = new FastbootDevice();

async function connect() {
    console.debug("Called connect()");

    try {
        await device.connect();
        document.querySelector("#unlock-button").disabled = false;
        document.querySelector("#connect-button").disabled = true;
        document.querySelector("#device-status").textContent = "Connected!";
    } catch (error) {
        console.error(error);
    }
}

async function unlockBootloader() {
    console.debug("Called unlockBootloader()");

    document.querySelector("#unlock-button").disabled = true;
    document.querySelector("#device-status").textContent = "Unlocking...";

    try {
        const resp = await device.runCommand("oem get_identifier_token");
        const identifierToken = resp.text.split('\n')[2];
        const identifier = identifierToken + "0".repeat(64 * 2).substring(identifierToken.length);

        console.debug("Identifier:", identifier);

        if (identifier.length > (64 * 2)) {
            throw new FastbootError(
                "FAIL",
                `Identifier token size overflow: ${identifier.length} is more than ${64 * 2} digits`);
        }

        let privateKey = defaultKey;

        const sig = new KJUR.crypto.Signature({"alg": "SHA256withRSA"});
        sig.init(privateKey);
        const signature = sig.signHex(identifier);
        const buffer = new Uint8Array(signature.match(/[\dA-F]{2}/gi).map(s => parseInt(s, 16)))

        // Bootloader requires an 8-digit hex number
        let xferHex = buffer.byteLength.toString(16).padStart(8, "0");
        if (xferHex.length !== 8) {
            throw new FastbootError(
                "FAIL",
                `Transfer size overflow: ${xferHex} is more than 8 digits`
            );
        }

        // Check with the device and make sure size matches
        let downloadResp = await device.runCommand(`download:${xferHex}`);
        if (downloadResp.dataSize === null) {
            throw new FastbootError(
                "FAIL",
                `Unexpected response to download command: ${downloadResp.text}`
            );
        }
        let downloadSize = parseInt(downloadResp.dataSize, 16);
        if (downloadSize !== buffer.byteLength) {
            throw new FastbootError(
                "FAIL",
                `Bootloader wants ${buffer.byteLength} bytes, requested to send ${buffer.bytelength} bytes`
            );
        }

        console.log(`Sending payload: ${buffer.byteLength} bytes`);
        await device.sendRawPayload(buffer, () => {});

        console.log("Payload sent, waiting for response...");
        await device.readResponse();

        console.log(await device.runCommand("flashing unlock_bootloader"));

        document.querySelector("#device-status").textContent = "Unlocked!";
    } catch (error) {
        console.error(error);
    }
}

$(document).ready(() => {
    bsCustomFileInput.init();

    document
        .querySelector("#connect-button")
        .addEventListener("click", connect);
    document
        .querySelector("#unlock-button")
        .addEventListener("click", unlockBootloader);
})
