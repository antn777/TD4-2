import bodyParser from "body-parser";
import express from "express";
import {BASE_ONION_ROUTER_PORT, REGISTRY_PORT} from "../config";
import { generateRsaKeyPair, exportPrvKey, exportPubKey } from "../crypto";
import * as http from "node:http";

export async function simpleOnionRouter(nodeId: number) {
  const onionRouter = express();
  onionRouter.use(express.json());
  onionRouter.use(bodyParser.json());

  const { publicKey, privateKey } = await generateRsaKeyPair();
  const privateKeyBase64 = await exportPrvKey(privateKey);
  const publicKeyBase64 = await exportPubKey(publicKey);

  let lastReceivedEncryptedMessage: string | null = null;
  let lastReceivedDecryptedMessage: string | null = null;
  let lastMessageDestination: number | null = null;

  onionRouter.get("/getPrivateKey", (req, res) => {
    res.json({ result: privateKeyBase64 });
  });

  onionRouter.get("/getLastReceivedEncryptedMessage", (req, res) => {
    res.json({ result: lastReceivedEncryptedMessage });
  });
  onionRouter.get("/getLastReceivedDecryptedMessage", (req, res) => {
    res.json({ result: lastReceivedDecryptedMessage });
  });
  onionRouter.get("/getLastMessageDestination", (req, res) => {
    res.json({ result: lastMessageDestination });
  });
  // TODO implement the status route
  onionRouter.get("/status", (req, res) => {
    res.send("live");
  });
  const registerNode = () => {
    const postData = JSON.stringify({ nodeId, pubKey: publicKeyBase64 });

    const options = {
      hostname: 'localhost',
      port: REGISTRY_PORT,
      path: '/registerNode',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = http.request(options, (res) => {
      res.on('end', () => {
        console.log(`Node ${nodeId} registered successfully with the registry.`);
      });
    });

    req.on('error', (error) => {
      console.error(`Failed to register node ${nodeId} with the registry:`, error);
    });

    req.write(postData);
    req.end();
  };

  registerNode();
  const server = onionRouter.listen(BASE_ONION_ROUTER_PORT + nodeId, () => {
    console.log(
      `Onion router ${nodeId} is listening on port ${
        BASE_ONION_ROUTER_PORT + nodeId
      }`
    );
  });

  return server;
}
