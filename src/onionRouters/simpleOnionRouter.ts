// File: src/onionRouters/simpleOnionRouter.ts

import bodyParser from "body-parser";
import express from "express";
import { BASE_ONION_ROUTER_PORT, BASE_USER_PORT, REGISTRY_PORT } from "../config";
import { generateRsaKeyPair, exportPrvKey, exportPubKey, rsaDecrypt, symDecrypt } from "../crypto";
import * as http from "node:http";
import { SendMessageBody } from "../users/user";

export async function simpleOnionRouter(nodeId: number) {
  const onionRouter = express();
  onionRouter.use(express.json());
  onionRouter.use(bodyParser.json());

  // Generate RSA key pair for this node; public key is for encryption, private key for decryption.
  const { publicKey, privateKey } = await generateRsaKeyPair();
  const privateKeyBase64 = await exportPrvKey(privateKey);
  const publicKeyBase64 = await exportPubKey(publicKey);

  // State variables used to track internal status for testing.
  let lastReceivedEncryptedMessage: string | null = null;
  let lastReceivedDecryptedMessage: string | null = null;
  let lastMessageDestination: number | null = null;
  let lastCircuit: number[] | null = null; // Will hold the node IDs that processed the message

  // GET route to retrieve the node's private key (for testing purposes)
  onionRouter.get("/getPrivateKey", (req, res) => {
    res.json({ result: privateKeyBase64 });
  });
  // GET route to retrieve the last received encrypted message
  onionRouter.get("/getLastReceivedEncryptedMessage", (req, res) => {
    res.json({ result: lastReceivedEncryptedMessage });
  });
  // GET route to retrieve the last received decrypted message
  onionRouter.get("/getLastReceivedDecryptedMessage", (req, res) => {
    res.json({ result: lastReceivedDecryptedMessage });
  });
  // GET route to retrieve the destination of the last message
  onionRouter.get("/getLastMessageDestination", (req, res) => {
    res.json({ result: lastMessageDestination });
  });
  // GET route to retrieve the forwarding circuit (node IDs) that processed the last message
  onionRouter.get("/getLastCircuit", (req, res) => {
    res.json({ result: lastCircuit });
  });

  // /message route: decrypt one layer of the onion and forward the message.
  onionRouter.post("/message", async (req, res) => {
    const { message } = req.body as SendMessageBody;
    lastReceivedEncryptedMessage = message;

    // Each onion layer is structured as follows:
    // • The first 344 characters: RSA-encrypted symmetric key.
    // • The remainder: an AES-CBC encrypted payload.
    const encryptedSymKey = message.slice(0, 344);
    const encryptedData = message.slice(344);

    // Decrypt the symmetric key with this node's private RSA key,
    // then use it to decrypt the AES-CBC encrypted payload.
    const symKeyBase64 = await rsaDecrypt(encryptedSymKey, privateKey);
    const decryptedLayer = await symDecrypt(symKeyBase64, encryptedData);

    // The first 10 characters of the decrypted layer encode the destination port as a 10-character, zero-padded string.
    const destinationStr = decryptedLayer.slice(0, 10);
    const destination = parseInt(destinationStr, 10);
    // The remaining characters are the onion payload to be forwarded.
    const remainingMessage = decryptedLayer.slice(10);

    lastMessageDestination = destination;
    lastReceivedDecryptedMessage = remainingMessage;
    
    // Always update the circuit record with this node's ID.
    if (!lastCircuit) lastCircuit = [];
    if (!lastCircuit.includes(nodeId)) {
      lastCircuit.push(nodeId);
    }

    // Forward based on the destination:
    // If destination >= BASE_USER_PORT, then it is intended for a user.
    if (destination >= BASE_USER_PORT) {
      const postData = JSON.stringify({ message: remainingMessage });
      const options = {
        hostname: "localhost",
        port: destination,
        path: "/message",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData)
        },
      };
      const forwardReq = http.request(options, (forwardRes) => {
        let data = "";
        forwardRes.on("data", (chunk) => { data += chunk; });
        forwardRes.on("end", () => {
          console.log(`Message forwarded to user at port ${destination}: ${data}`);
        });
      });
      forwardReq.on("error", (error) => {
        console.error(`Error forwarding message to user at port ${destination}:`, error);
      });
      forwardReq.write(postData);
      forwardReq.end();
      res.status(200).send("Message delivered to user");
    } else {
      // Otherwise, forward to the next onion router.
      const postData = JSON.stringify({ message: remainingMessage });
      const options = {
        hostname: "localhost",
        port: destination,
        path: "/message",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData)
        },
      };
      const forwardReq = http.request(options, (forwardRes) => {
        let data = "";
        forwardRes.on("data", (chunk) => { data += chunk; });
        forwardRes.on("end", () => {
          console.log(`Message forwarded to onion router at port ${destination}: ${data}`);
        });
      });
      forwardReq.on("error", (error) => {
        console.error(`Error forwarding message to onion router at port ${destination}:`, error);
      });
      forwardReq.write(postData);
      forwardReq.end();
      res.status(200).send("Message forwarded to onion router");
    }
  });

  // Basic /status route.
  onionRouter.get("/status", (req, res) => {
    res.send("live");
  });

  // Register this node with the registry.
  const registerNode = () => {
    const postData = JSON.stringify({ nodeId, pubKey: publicKeyBase64 });
    const options = {
      hostname: "localhost",
      port: REGISTRY_PORT,
      path: "/registerNode",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      },
    };
    const regReq = http.request(options, (response) => {
      let data = "";
      response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => {
        console.log(`Node ${nodeId} registered successfully with the registry. Response: ${data}`);
      });
    });
    regReq.on("error", (error) => {
      console.error(`Failed to register node ${nodeId} with the registry:`, error);
    });
    regReq.write(postData);
    regReq.end();
  };
  registerNode();

  const server = onionRouter.listen(BASE_ONION_ROUTER_PORT + nodeId, () => {
    console.log(`Onion router ${nodeId} is listening on port ${BASE_ONION_ROUTER_PORT + nodeId}`);
  });
  return server;
}
