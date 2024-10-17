"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const redis_1 = require("redis");
const aws_1 = require("./aws");
const utils_1 = require("./utils");
// Redis connection details from Redis Labs
const redisHost = "redis-14043.c305.ap-south-1-1.ec2.redns.redis-cloud.com";
const redisPort = 14043;
const redisPassword = "pGvHPUdKjVESP6EYRAz4epbxNaZS9qcq";
function createRedisClients() {
    return __awaiter(this, void 0, void 0, function* () {
        const publisher = (0, redis_1.createClient)({
            socket: {
                host: redisHost,
                port: redisPort,
            },
            password: redisPassword
        });
        publisher.on('error', (err) => {
            console.error('Redis Publisher Connection Error:', err);
        });
        yield publisher.connect();
        console.log('Publisher connected');
        const subscriber = (0, redis_1.createClient)({
            socket: {
                host: redisHost,
                port: redisPort,
            },
            password: redisPassword
        });
        subscriber.on('error', (err) => {
            console.error('Redis Subscriber Connection Error:', err);
        });
        yield subscriber.connect();
        console.log('Subscriber connected');
        return { publisher, subscriber };
    });
}
let publisher;
let subscriber;
function main() {
    return __awaiter(this, void 0, void 0, function* () {
        const clients = yield createRedisClients();
        publisher = clients.publisher;
        subscriber = clients.subscriber;
        while (true) {
            const res = yield subscriber.brPop((0, redis_1.commandOptions)({ isolated: true }), 'build-queue', 0);
            console.log(res.element);
            // @ts-ignore;
            const id = res.element;
            yield (0, aws_1.downloadS3Folder)(`output/${id}`);
            yield (0, utils_1.buildProject)(id);
            (0, aws_1.copyFinalDist)(id);
            yield publisher.hSet("status", id, "deployed");
        }
    });
}
main();
