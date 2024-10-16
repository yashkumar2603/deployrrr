import express, { Request, Response } from "express";
import cors from "cors";
import simpleGit from "simple-git";
import { generate } from "./utils"; 
import { getAllFiles } from "./file"; 
import path from "path";
import { uploadFile } from "./aws";
import { createClient } from "redis";

// Redis connection details from Redis Labs
const redisHost: string = "redis-14043.c305.ap-south-1-1.ec2.redns.redis-cloud.com"; 
const redisPort: number = 14043; 
const redisPassword: string = "pGvHPUdKjVESP6EYRAz4epbxNaZS9qcq"; 

async function createRedisClients() {
    const publisher = createClient({
        socket: {
            host: redisHost,
            port: redisPort,
        },
        password: redisPassword
    });
    
    publisher.on('error', (err) => {
        console.error('Redis Publisher Connection Error:', err);
    });

    await publisher.connect();
    console.log('Publisher connected');

    const subscriber = createClient({
        socket: {
            host: redisHost,
            port: redisPort,
        },
        password: redisPassword
    });
    
    subscriber.on('error', (err) => {
        console.error('Redis Subscriber Connection Error:', err);
    });

    await subscriber.connect();
    console.log('Subscriber connected');

    return { publisher, subscriber };
}

// Create Express app
const app = express();
app.use(cors());
app.use(express.json());

let publisher: any;
let subscriber: any;

(async () => {
    const clients = await createRedisClients();
    publisher = clients.publisher;
    subscriber = clients.subscriber;

    app.post("/deploy", async (req: Request, res: Response) => {
        const repoUrl = req.body.repoUrl;
        const id = generate(); // e.g., asd12
        await simpleGit().clone(repoUrl, path.join(__dirname, `output/${id}`));

        const files = getAllFiles(path.join(__dirname, `output/${id}`));

        await Promise.all(files.map(async file => {
            await uploadFile(file.slice(__dirname.length + 1), file);
        }));

        await new Promise((resolve) => setTimeout(resolve, 5000));
        await publisher.lPush("build-queue", id);
        // INSERT => SQL
        // .create => 
        await subscriber.hSet("status", id, "uploaded");

        res.json({
            id: id
        });
    });

    app.get("/status", async (req: Request, res: Response) => {
        const id = req.query.id;
        const response = await subscriber.hGet("status", id as string);
        res.json({
            status: response
        });
    });

    // Start the server
    app.listen(3000, () => {
        console.log("Server is running on port 3000");
    });
})();
