import bodyParser from "body-parser";
import express from "express";
import http from "http";
import { BASE_ONION_ROUTER_PORT, BASE_USER_PORT, REGISTRY_PORT } from "../config";
import { createRandomSymmetricKey, exportSymKey, rsaEncrypt, symEncrypt } from "../crypto";

export type SendMessageBody = {
  message: string;
  destinationUserId: number;
};

export async function user(userId: number) {
  const _user = express();
  _user.use(express.json());
  _user.use(bodyParser.json());

  let lastReceivedMessage: string | null = null;
  let lastSentMessage: string | null = null;
  let lastCircuit: number[] | null = null;

  _user.post("/message", (req, res) => {
    const { message } = req.body as SendMessageBody;
    lastReceivedMessage = message;
    res.status(200).send("success");
  });

  _user.get("/getLastReceivedMessage", (req, res) => {
    res.json({ result: lastReceivedMessage });
  });

  _user.get("/getLastSentMessage", (req, res) => {
    res.json({ result: lastSentMessage });
  });

  _user.get("/getLastCircuit", (req, res) => {
    res.json({ result: lastCircuit });
  });

  _user.post("/sendMessage", async (req, res) => {
    const { message, destinationUserId } = req.body as SendMessageBody;

    const registryResponse = await fetch(`http://localhost:${REGISTRY_PORT}/getNodeRegistry`);
    const registryData = await registryResponse.json() as { nodes: Array<{ nodeId: number; pubKey: string }> };
    const nodes = registryData.nodes;

    const circuit: Array<{ nodeId: number; pubKey: string }> = [];
    while (circuit.length < 3) {
      const candidate = nodes[Math.floor(Math.random() * nodes.length)];
      if (!circuit.some(n => n.nodeId === candidate.nodeId)) {
        circuit.push(candidate);
      }
    }

    lastCircuit = circuit.map(node => node.nodeId);

    let onionPayload: string = message;
    for (let i = circuit.length - 1; i >= 0; i--) {
      const node = circuit[i];

      const symKey = await createRandomSymmetricKey();
      const symKeyBase64 = await exportSymKey(symKey);

      const encryptedSymKey = await rsaEncrypt(symKeyBase64, node.pubKey);

      let destinationStr: string;
      if (i === circuit.length - 1) {
        destinationStr = (BASE_USER_PORT + destinationUserId).toString().padStart(10, "0");
      } else {
        destinationStr = (BASE_ONION_ROUTER_PORT + circuit[i + 1].nodeId).toString().padStart(10, "0");
      }

      const layer = destinationStr + onionPayload;
      const symEncryptedLayer = await symEncrypt(symKey, layer);

      onionPayload = encryptedSymKey + symEncryptedLayer;
    }

    const entryNode = circuit[0];
    const postData = JSON.stringify({ message: onionPayload });
    const options = {
      hostname: "localhost",
      port: BASE_ONION_ROUTER_PORT + entryNode.nodeId,
      path: "/message",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
      },
    };

    const httpReq = http.request(options, (response) => {
      let data = "";
      response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => { console.log("Message sent successfully:", data); });
    });

    httpReq.on("error", (error) => {
      console.error("Error sending message:", error);
    });

    httpReq.write(postData);
    httpReq.end();

    lastSentMessage = message;
    res.status(200).send("Message sent");
  });
  // TODO implement the status route
  _user.get("/status", (req, res) => {
    res.send("live");
  });

  const server = _user.listen(BASE_USER_PORT + userId, () => {
    console.log(`User ${userId} is listening on port ${BASE_USER_PORT + userId}`);
  });

  return server;
}