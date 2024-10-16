import { createClient, commandOptions } from "redis";
import { copyFinalDist, downloadS3Folder } from "./aws";
import { buildProject } from "./utils";

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

let publisher: any;
let subscriber: any;

async function main() {
    const clients = await createRedisClients();
    publisher = clients.publisher;
    subscriber = clients.subscriber;

    while (true) {
        const res = await subscriber.brPop(
            commandOptions({ isolated: true }),
            'build-queue',
            0
        );
        console.log(res.element);
        // @ts-ignore;
        const id = res.element

        await downloadS3Folder(`output/${id}`);
        await buildProject(id);
        copyFinalDist(id);
        await publisher.hSet("status", id, "deployed");
    }
}
main();
